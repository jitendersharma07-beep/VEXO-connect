// Cash-drawer pulse profiles (contract §5).
//
// A till drawer is not opened by software. It is opened by a solenoid, and the
// solenoid is driven by a printer that closes a circuit on one of two pins in
// the RJ-11 connector on its back for a few milliseconds. Everything this file
// does is decide WHICH pin and FOR HOW LONG, and refuse anything outside what
// the hardware documentation covers.
//
// WHY THERE IS NO RAW COMMAND FIELD ANYWHERE. The obvious design is a text
// column holding the bytes to send, so any printer can be supported by typing
// its escape sequence in. That column is a remote code execution primitive
// pointed at a device on the shop floor: whoever can write it can make the
// printer do anything it is capable of, including things that are not printing.
// So there is no such column, no shell, and no pass-through — an operator
// chooses a pin and two durations, both bounded, and nothing else reaches the
// hardware. A printer that speaks a different dialect needs an adapter written
// here, not a field somebody can paste bytes into.
//
// THE COMMAND. ESC/POS generalised pulse is `ESC p m t1 t2` (1B 70 m t1 t2):
//   m  selects the connector pin — Epson's command reference defines
//      m ∈ {0, 1, 48, 49}, where 0 and 48 are pin 2 and 1 and 49 are pin 5.
//   t1 the ON time, t2 the OFF time, each in units of 2 ms, each 0–255.
// Stored as the pin number a technician reads off the cable and milliseconds a
// person can reason about; converted at the agent, which is the only code that
// ever forms the byte sequence.
//
// THE BOUNDS ARE NARROWER THAN THE PROTOCOL. The protocol permits an ON time up
// to 510 ms. A drawer solenoid is a coil sized for a pulse, not for continuous
// duty, and holding one energised is how a coil overheats and a drawer stops
// working mid-service. Epson's own guidance is that the pulse should be brief
// and the manufacturer's rating is what governs; 200 ms is comfortably above
// every profile in circulation and comfortably below anything that cooks a
// coil, so that is the ceiling here. The floor of 10 ms exists because a pulse
// shorter than the solenoid's pull-in time is a command that quietly does
// nothing — the software reports success and the drawer stays shut.

// Pin 2 and pin 5 are the two the connector carries. A single-drawer till uses
// pin 2; the second is for the shop that runs two drawers off one printer.
export const DRAWER_PINS = [2, 5];

// Milliseconds, and the same numbers as the DeviceCommand_drawer_profile CHECK
// in the database. Duplicated on purpose rather than derived: a value that gets
// past this module — a future route, a script, a migration — still meets the
// constraint, and a constraint that disagrees with the code is one that fails
// at the worst possible moment instead of the earliest.
export const DRAWER_ON_MS = { min: 10, max: 200 };
export const DRAWER_OFF_MS = { min: 10, max: 510 };

// What a printer gets if nobody has configured it. Conservative: the shortest
// pulse that reliably throws every mechanism we have notes for.
export const DRAWER_DEFAULTS = { drawerPin: 2, drawerOnMs: 50, drawerOffMs: 200 };

export class DrawerProfileError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'DrawerProfileError';
    this.field = field;
  }
}

const inRange = (value, { min, max }) => Number.isInteger(value) && value >= min && value <= max;

// Validates a profile and returns exactly the three numbers, nothing else.
//
// Returning a fresh object rather than the input is the point: whatever else
// the caller's object carried does not travel to the hardware layer. The
// command row is built from THIS, so a field nobody validated cannot ride along.
export const validateDrawerProfile = ({ drawerPin, drawerOnMs, drawerOffMs } = {}) => {
  if (!DRAWER_PINS.includes(drawerPin)) {
    throw new DrawerProfileError(
      `The drawer pin must be ${DRAWER_PINS.join(' or ')} — those are the two the connector carries`,
      'drawerPin',
    );
  }
  if (!inRange(drawerOnMs, DRAWER_ON_MS)) {
    throw new DrawerProfileError(
      `The drawer pulse must be between ${DRAWER_ON_MS.min} and ${DRAWER_ON_MS.max} ms. ` +
        'Shorter does not throw the mechanism; longer overheats the coil.',
      'drawerOnMs',
    );
  }
  if (!inRange(drawerOffMs, DRAWER_OFF_MS)) {
    throw new DrawerProfileError(
      `The drawer off time must be between ${DRAWER_OFF_MS.min} and ${DRAWER_OFF_MS.max} ms`,
      'drawerOffMs',
    );
  }
  return { drawerPin, drawerOnMs, drawerOffMs };
};

// The profile a command is frozen with, taken from the printer it will run on.
// Frozen rather than read at dispatch time so an operator editing the profile
// while a command is in flight cannot change what that command does to the
// hardware — the row carries its own pulse, and the agent runs the row.
export const profileOfTarget = (target) =>
  validateDrawerProfile({
    drawerPin: target.drawerPin ?? DRAWER_DEFAULTS.drawerPin,
    drawerOnMs: target.drawerOnMs ?? DRAWER_DEFAULTS.drawerOnMs,
    drawerOffMs: target.drawerOffMs ?? DRAWER_DEFAULTS.drawerOffMs,
  });

// A drawer-open request is only meaningful for as long as the person who asked
// is still standing at the till. Past this the command is EXPIRED and no agent
// may run it, however long it was offline.
//
// Thirty seconds, because the failure it prevents is specific and physical: an
// agent that lost its network at 14:00 and reconnects at 18:00 must not open a
// drawer in an empty shop for a sale that finished four hours ago. The number
// is the honest answer to "how long after pressing the button is opening the
// drawer still what the cashier meant?", and that is measured in seconds.
export const COMMAND_TTL_SEC = 30;

// How long an agent holds a claimed command before it is considered lost. The
// same 60 s the print queue uses, and the same discipline: a lease that runs
// out makes the command UNCERTAIN, never QUEUED again.
export const COMMAND_LEASE_SEC = 60;

// What an agent is told to do, and the whole of it. No host, no transport, no
// command bytes — the agent already knows how to reach its own printer, and
// what comes over the wire is three validated numbers.
export const commandPayload = (command) => ({
  id: command.id,
  kind: command.kind,
  targetId: command.targetId,
  drawerPin: command.drawerPin,
  drawerOnMs: command.drawerOnMs,
  drawerOffMs: command.drawerOffMs,
  expiresAt: command.expiresAt,
});

// Whether a physical claim may be made about this command.
//
// `ackAt` means the agent reported that it drove the pin. That is a claim about
// SOFTWARE: the bytes went out and the port did not complain. It is NOT a claim
// that the drawer moved, and it must never be reported as one — a jammed
// mechanism, a disconnected cable and a drawer someone is holding shut all
// acknowledge identically.
//
// The only thing that can say a drawer opened is a sensor on the drawer, and
// only a target whose technician has confirmed one is wired declares
// drawerSensor. Everywhere else the honest word is "acknowledged".
export const drawerClaim = (command, target) => {
  if (command.sensorConfirmed) return 'OPENED';
  if (command.ackAt) return target?.drawerSensor ? 'ACKNOWLEDGED_NOT_OPENED' : 'ACKNOWLEDGED';
  return 'UNKNOWN';
};

// The sentence that goes with each claim, because this is the distinction an
// operator is most likely to collapse on their own.
export const DRAWER_CLAIM_TEXT = {
  OPENED: 'the drawer sensor reported the drawer open',
  ACKNOWLEDGED: 'the printer accepted the pulse — this printer has no drawer sensor, so whether the drawer actually opened is not known',
  ACKNOWLEDGED_NOT_OPENED: 'the printer accepted the pulse but the drawer sensor did not report the drawer open',
  UNKNOWN: 'no acknowledgement was received',
};
