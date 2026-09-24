// ENTITLEMENT(INVENTORY)
//
// The inventory module's single mount point. Authentication and company scope
// are applied once, here, so no sub-router can be added later that forgets
// them — a route file that is mounted is a route file that is scoped.
//
// Split by what a person is doing rather than by table:
//
//   setup        locations, items, units, suppliers, settings
//   batches      what is on the shelf, when it dies, how to stop it moving
//   receiving    purchase orders, GRNs, supplier returns
//   requests     store requests, approval, dispatch, receipt, shortages
//   planning     replenishment plans, suggestions, reminders, notifications
//   adjustments  physical counts, wastage
//   recipes      what a sale consumes, and the way sold stock comes back
//   reports      stock, ledger, valuation, dashboard, traceability

import { Router } from 'express';
import { requirePosAuth, resolveCompanyScope } from '../../../middleware/auth.js';
import setupRoutes from './setup.js';
import batchRoutes from './batches.js';
import receivingRoutes from './receiving.js';
import requestRoutes from './requests.js';
import planningRoutes from './planning.js';
import adjustmentRoutes from './adjustments.js';
import recipeRoutes from './recipes.js';
import reportRoutes from './reports.js';

export { MODULE_KEY } from '../../../lib/inventory/permissions.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope);

router.use(setupRoutes);
router.use(batchRoutes);
router.use(receivingRoutes);
router.use(requestRoutes);
router.use(planningRoutes);
router.use(adjustmentRoutes);
router.use(recipeRoutes);
router.use(reportRoutes);

export default router;
