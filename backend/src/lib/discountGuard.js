// The gate every discount-moving route goes through.
//
// Split out of the routes on purpose: there are three ways to change what a
// bill discounts (a line discount, an order discount, clearing one) and they
// must not each grow their own idea of who is allowed to do it. Anything that
// can move money off an order calls guardDiscountChange first, or it is a bug.
//
// Approval is inline and per-request. There is no approval token, no "manager
// mode" that stays unlocked, and nothing persisted that a later request could
// spend: the approver's credential is checked against the exact discount in
// front of it, and the authority dies with the response. That is what makes
// "the approver's own authentication" true rather than a formality — a PIN
// pad left unlocked behind the counter is a shared credential with extra
// steps.

import { prisma } from './prisma.js';
import { verifyPassword, hashPassword } from './crypto.js';
import { audit } from './audit.js';
import { approvalRefused, discountDenied } from './errors.js';
import {
  authorizeApproval,
  authorizeDiscount,
  breachForAudit,
  combinedPctMilli,
  describeBreach,
  describeCeiling,
  resolveDiscountPolicy,
} from './discountPolicy.js';

// --- throttle ---------------------------------------------------------------
// An above-limit discount carrying an approval block is a password oracle: a
// cashier could sit at the till guessing the manager's password all evening.
// Failures are counted per approver email and per caller, successes clear the
// counter, and the window is long enough that guessing is not worth starting.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const failures = new Map(); // key -> { count, firstAt }

const throttleKey = (email, req) => `${email}|${req.user?.id ?? 'anon'}`;

const throttleState = (key) => {
  const rec = failures.get(key);
  if (!rec) return null;
  if (Date.now() - rec.firstAt > WINDOW_MS) {
    failures.delete(key);
    return null;
  }
  return rec;
};

const noteApprovalFailure = (key) => {
  const rec = throttleState(key);
  if (rec) rec.count += 1;
  else failures.set(key, { count: 1, firstAt: Date.now() });
};

const clearApprovalFailures = (key) => failures.delete(key);

// The suite drives deliberate failures; it resets between cases so one test's
// wrong passwords cannot 429 the next test's correct one.
export const resetApprovalThrottle = () => failures.clear();

// --- constant-ish time ------------------------------------------------------
// An unknown approver email must not answer faster than a wrong password, or
// the prompt becomes a way to enumerate colleagues' accounts from the till.
let decoyHash = null;
const burnVerify = async () => {
  decoyHash ??= await hashPassword('discount-approval-decoy');
  await verifyPassword(decoyHash, 'not-the-password');
};

// One message for every pre-authentication failure. Which of "no such
// account" and "wrong password" it was is exactly what an attacker wants.
const CREDENTIALS_REFUSED = 'Those approver credentials were not accepted.';

const policyDetails = (policy) => ({
  allowLineDiscount: policy.allowLineDiscount,
  allowOrderDiscount: policy.allowOrderDiscount,
  maxPctMilli: policy.maxPctMilli,
  maxFlatPaise: policy.maxFlatPaise,
  ceiling: describeCeiling(policy),
});

const exposureForAudit = (e) => ({
  grossPaise: e.grossPaise,
  lineDiscountPaise: e.lineDiscountPaise,
  orderDiscountPaise: e.orderDiscountPaise,
  combinedPaise: e.combinedPaise,
  combinedPctMilli: combinedPctMilli(e.combinedPaise, e.grossPaise),
});

/**
 * Decides whether this request may leave the order in the `after` state.
 *
 * Returns { policy, approver, reason } on success — approver is null when the
 * actor was inside their own limit and needed nobody. Throws a 403 otherwise,
 * having written the refusal to the audit log first: a denial nobody can find
 * afterwards is indistinguishable from a denial that never happened.
 */
export const guardDiscountChange = async (
  req,
  { order, before, after, shape, approval, action },
) => {
  const companyId = order.companyId;
  const policy = await resolveDiscountPolicy(prisma, {
    companyId,
    userId: req.user.id,
    role: req.user.role,
    branchId: order.branchId,
  });

  const verdict = authorizeDiscount({ policy, before, after, shape });
  if (verdict.ok) return { policy, approver: null, reason: null };

  const baseMeta = {
    branchId: order.branchId,
    before: exposureForAudit(before),
    after: exposureForAudit(after),
    actorLimit: policyDetails(policy),
    breach: breachForAudit(verdict.breach),
  };

  if (!approval) {
    await audit(req, {
      action: 'ORDER_DISCOUNT_DENIED',
      entity: 'Order',
      entityId: order.id,
      companyId,
      meta: { ...baseMeta, attemptedAction: action },
    });
    throw discountDenied(describeBreach(verdict.breach), {
      approvalRequired: true,
      breach: breachForAudit(verdict.breach),
      yourLimit: policyDetails(policy),
    });
  }

  // --- from here on, somebody is claiming authority they must prove ---------

  const key = throttleKey(approval.approverEmail, req);
  const throttled = throttleState(key);
  if (throttled && throttled.count >= MAX_FAILURES) {
    await audit(req, {
      action: 'ORDER_DISCOUNT_APPROVAL_THROTTLED',
      entity: 'Order',
      entityId: order.id,
      companyId,
      meta: { ...baseMeta, approverEmail: approval.approverEmail },
    });
    throw approvalRefused(
      'Too many failed approval attempts for that account. Try again in a few minutes.',
    );
  }

  const refuse = async (reasonCode, message, extra = {}) => {
    noteApprovalFailure(key);
    await audit(req, {
      action: 'ORDER_DISCOUNT_APPROVAL_FAILED',
      entity: 'Order',
      entityId: order.id,
      companyId,
      meta: { ...baseMeta, approverEmail: approval.approverEmail, refusal: reasonCode, ...extra },
    });
    return approvalRefused(message, { refusal: reasonCode, ...extra });
  };

  const approver = await prisma.posUser.findUnique({
    where: { email: approval.approverEmail },
    include: { branch: { select: { id: true, name: true, code: true } } },
  });

  // Cross-company approvers answer exactly like a wrong password: the till of
  // one customer must not be able to discover that an account at another
  // customer exists.
  if (!approver || approver.companyId !== companyId) {
    await burnVerify();
    throw await refuse('UNKNOWN_APPROVER', CREDENTIALS_REFUSED);
  }
  if (!(await verifyPassword(approver.passwordHash, approval.password))) {
    throw await refuse('BAD_PASSWORD', CREDENTIALS_REFUSED);
  }

  // Past this line the credential is proven, so the refusals can say what is
  // actually wrong without telling an attacker anything they did not know.
  if (approver.status !== 'ACTIVE') {
    throw await refuse('APPROVER_DISABLED', 'That account is disabled and cannot approve anything.');
  }
  if (approver.mustChangePassword) {
    throw await refuse(
      'APPROVER_MUST_CHANGE_PASSWORD',
      `${approver.fullName} must sign in and set a new password before approving discounts.`,
    );
  }

  // Branch scope. A branch manager's authority stops at their own branch —
  // this is the cross-branch case, and it is enforced here rather than left
  // to the UI offering the right list of names.
  const pinned = approver.role === 'BRANCH_MANAGER' || approver.role === 'CASHIER';
  if (pinned && approver.branchId !== order.branchId) {
    throw await refuse(
      'APPROVER_WRONG_BRANCH',
      `${approver.fullName} is assigned to ${approver.branch?.name ?? 'another branch'} and cannot approve a discount at this branch.`,
      { approverBranchId: approver.branchId ?? null },
    );
  }

  const approverPolicy = await resolveDiscountPolicy(prisma, {
    companyId,
    userId: approver.id,
    role: approver.role,
    branchId: order.branchId,
  });
  const approvalVerdict = authorizeApproval({ policy: approverPolicy, after });
  if (!approvalVerdict.ok) {
    throw await refuse('APPROVER_OVER_LIMIT', describeBreach(approvalVerdict.breach), {
      breach: breachForAudit(approvalVerdict.breach),
      approverLimit: {
        canApprove: approverPolicy.canApprove,
        maxPctMilli: approverPolicy.maxApprovalPctMilli,
        maxFlatPaise: approverPolicy.maxApprovalFlatPaise,
        ceiling: describeCeiling({
          maxPctMilli: approverPolicy.maxApprovalPctMilli,
          maxFlatPaise: approverPolicy.maxApprovalFlatPaise,
        }),
      },
    });
  }

  clearApprovalFailures(key);
  return {
    policy,
    approver: {
      id: approver.id,
      email: approver.email,
      fullName: approver.fullName,
      role: approver.role,
      // True when the operator approved their own above-limit discount with
      // their own higher approval ceiling. Legitimate — a manager alone on a
      // late shift has nobody else — but recorded, because "who signed for
      // this" and "who rang it up" being the same person is the first thing
      // anybody reviewing a discount wants to know.
      selfApproved: approver.id === req.user.id,
    },
    reason: approval.reason,
  };
};
