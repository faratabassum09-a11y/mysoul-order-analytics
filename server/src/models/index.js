const mongoose = require('mongoose');
const { Schema } = mongoose;

// Last raw copy of each source tab, so cleaning can be re-run without re-fetching.
const Snapshot = mongoose.model('Snapshot', new Schema({
  tab: { type: String, unique: true }, // 'order' | 'master'
  rows: Schema.Types.Mixed,
  source: String,
  hash: String, // fingerprint of rows: lets auto-sync skip re-cleaning when the sheet has not changed
  fetchedAt: Date,
}));

// Order dates from Shopify (CSV upload or the API sync). Used to date sheet rows that have no date.
const ShopifyDate = mongoose.model('ShopifyDate', new Schema({
  orderId: { type: Number, unique: true },
  createdAt: Date,
}));

const Order = mongoose.model('Order', new Schema({
  sheetRow: { type: Number, unique: true },
  orderId: { type: Number, index: true },
  orderDate: { type: Date, index: true },
  dateSource: String,
  name: String, phone: String, email: String,
  amount: Number,
  product: String, orderLink: String,
  paymentMode: { type: String, index: true },
  confirmed: String, // Yes | Cancel | Pending
  dispatchYes: Boolean, dispatched: Boolean,
  deliveryStatus: String,
  ndr: Boolean, rto: String,
  finalStatus: { type: String, index: true },
  notes: String, rtoReason: String,
  pincode: String, masterTags: String, // from OrdersMaster, used by Step 3
  syncId: { type: String, index: true }, // which sync wrote this row (used for the no-gap swap)
  excluded: { type: String, default: null, index: true }, // null | noid | duplicate | test
  excludedReason: String, duplicateOf: Number,
  conflicts: [String],
  log: [String],
  raw: [String],
}, { minimize: false }));

// Customer details and items from the Shopify Admin API, one document per order number.
const ShopifyOrder = mongoose.model('ShopifyOrder', new Schema({
  orderId: { type: Number, unique: true }, // the number in the name: "#1300" -> 1300 (matches Order.orderId)
  shopifyId: String, name: String,
  createdAt: Date, updatedAt: Date, cancelledAt: Date, test: Boolean,
  financialStatus: String, fulfillmentStatus: String, paymentGateways: [String],
  currency: String, subtotal: Number, shipping: Number, discounts: Number, total: Number,
  note: String, tags: [String],
  customer: { name: String, email: String, phone: String },
  address: { name: String, line1: String, line2: String, city: String, state: String, zip: String, country: String, phone: String },
  items: [{ _id: false, title: String, variantTitle: String, sku: String, quantity: Number, orderedQuantity: Number, price: Number }],
  itemsSummary: String,
  tracking: [{ _id: false, number: String, company: String, url: String }], // AWB(s) Shopify holds for the order (fulfillment tracking info)
  marketing: {
    utmSource: String, utmMedium: String, utmCampaign: String, utmTerm: String, utmContent: String, sourceGroup: String,
    landingPath: String, landingProduct: String, checkoutPayment: String, additionalCharge: Number,
    device: String, inApp: String, hasUtm: Boolean,
    extra: [{ _id: false, key: String, value: String }],
  },
  attrsV: Number, // version of the marketing mapping this document was written with
  syncedAt: Date,
}, { minimize: false }));

// Tracking status from Shipway, one document per order number. Kept apart from Order: the sheet status and the Shipway status are shown side by side.
const ShipwayShipment = mongoose.model('ShipwayShipment', new Schema({
  orderId: { type: Number, unique: true },
  found: Boolean, // false = Shipway has no shipment under this order number (yet)
  shipwayOrderId: String, // the id format that matched ("1874" or "#1874")
  statusCode: String, status: String, group: { type: String, index: true }, final: Boolean,
  carrier: String, awb: String, from: String, to: String,
  pickupDate: String, statusTime: String, statusAt: Date,
  history: [{ _id: false, code: String, status: String, at: Date }], // changes seen by this app (Shipway's reply carries only the latest status)
  checkedAt: Date, changedAt: Date, error: String,
}, { minimize: false }));

const syncRunSchema = new Schema({
  at: { type: Date, default: Date.now },
  changed: Boolean, // false = sheet checked, nothing new
  trigger: String, // manual | auto | upload | shopify-upload | settings
  source: String,
  ok: Boolean,
  error: String,
  summary: Schema.Types.Mixed,
  warnings: [String],
});
syncRunSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 }); // 96 runs a day: keep 30 days
const SyncRun = mongoose.model('SyncRun', syncRunSchema);

const Setting = mongoose.model('Setting', new Schema({
  key: { type: String, unique: true },
  value: Schema.Types.Mixed,
}));


// ---------------------------------------------------------------------------------------------
// Confirm Queue + Dispatch Desk (team workflow). Kept apart from Order: the sheet sync rewrites Order rows,
// so anything the team does lives here, keyed by order number, and is never overwritten by a sync.
// ---------------------------------------------------------------------------------------------

// One login per person. Never shared: every action in the flow is stamped with the person who did it.
const StaffUser = mongoose.model('StaffUser', new Schema({
  username: { type: String, unique: true }, // lower case
  name: String,
  role: { type: String, enum: ['admin', 'confirmation', 'packing'], index: true },
  passwordHash: String,
  active: { type: Boolean, default: true },
  mustChangePassword: { type: Boolean, default: false },
  tokenVersion: { type: Number, default: 0 }, // bump to sign a person out everywhere
  lastLoginAt: Date,
  createdBy: String,
}, { timestamps: true }));

// Current state of one order inside the flow.
const orderFlowSchema = new Schema({
  orderId: { type: Number, unique: true },
  orderAt: Date, // copy of the order time: the SLA clock starts here
  // ---- confirm stage ----
  confirmStatus: { type: String, default: 'pending', index: true }, // pending | no_answer | confirmed | partial_pay | cancelled
  noAnswerAttempts: { type: Number, default: 0 },
  lastAttemptAt: Date,
  escalated: { type: Boolean, default: false },
  cancelReason: String,
  partial: { amount: Number, at: Date, byId: String, byName: String },
  partialLinkSentAt: Date,
  decidedAt: Date, decidedById: String, decidedByName: String, // the first final decision (confirm / partial / cancel)
  confirmedAt: Date, // starts the 24 h dispatch plan
  // ---- dispatch stage ----
  dispatchStage: { type: String, default: null, index: true }, // null | print_slip | ready_for_pickup | dispatched
  slipPrintedAt: Date, slipPrintedById: String, slipPrintedByName: String,
  awb: { type: String },
  weightG: Number,
  packedAt: Date, packedById: String, packedByName: String,
  readyAt: Date,
  dispatchedAt: Date, dispatchedById: String, dispatchedByName: String,
  delayReason: String,
  proofs: { type: Number, default: 0 },
}, { timestamps: true, minimize: false });
orderFlowSchema.index({ awb: 1 }, { unique: true, partialFilterExpression: { awb: { $type: 'string' } } }); // one AWB, one order
const OrderFlow = mongoose.model('OrderFlow', orderFlowSchema);

// Append-only history. There is no route that edits or deletes a row here.
const flowEventSchema = new Schema({
  orderId: { type: Number, index: true },
  at: { type: Date, default: Date.now, index: true },
  byId: String, byName: String, role: String,
  stage: String, // confirm | dispatch | contact
  action: String, // confirm | partial_pay | cancel | no_answer | auto_cancel | escalate | call | whatsapp | partial_link | slip_printed | packed | ready | dispatched | delay_reason | proof_added
  previous: String, next: String, // status before and after (the "previous status" every log must carry)
  label: String, // plain-language line for the timeline
  reasonKey: String,
  meta: Schema.Types.Mixed,
}, { minimize: false, versionKey: false });
flowEventSchema.index({ orderId: 1, at: 1 });
const FlowEvent = mongoose.model('FlowEvent', flowEventSchema);

// Photos (and later videos) of the sealed box on the scale. Stored in MongoDB so they survive redeploys on hosts with a temporary disk.
const FlowProof = mongoose.model('FlowProof', new Schema({
  orderId: { type: Number, index: true },
  kind: { type: String, enum: ['photo', 'video'], default: 'photo' },
  mime: String, size: Number, sha256: String,
  data: Buffer,
  awb: String, weightG: Number,
  byId: String, byName: String,
  at: { type: Date, default: Date.now },
}, { versionKey: false }));


// ---------------------------------------------------------------------------------------------
// Shopify Desk: orders straight from Shopify, worked through FU1-FU3 -> Pending -> Dispatch / Cancelled.
// Keyed by Shopify order number. Independent of the sheet-based Confirm Queue above.
// ---------------------------------------------------------------------------------------------
const deskOrderSchema = new Schema({
  orderId: { type: Number, unique: true },
  orderAt: { type: Date, index: true }, // Shopify created time
  stage: { type: String, default: 'confirm', index: true }, // confirm | pending | dispatch | dispatched | cancelled
  fuNo: { type: Number, default: 1 }, // 1..3 inside confirm (FU1-3) and pending (Day 1-3)
  dueAt: { type: Date, index: true },
  pendingSince: Date,
  dnpCount: { type: Number, default: 0 },
  lastDnpAt: Date,
  confirmedAt: Date, confirmedAtFu: String, confirmedBy: String,
  partial: { amount: Number, balance: Number, notes: String, screenshotId: String, at: Date, byName: String, fromFu: String },
  cancel: { reason: String, note: String, at: Date, byName: String, auto: Boolean, fromStage: String },
  dispatch: { at: Date, byName: String, awb: String, courier: String, note: String },
  // Dispatch queue progress while stage === 'dispatch' (see lib/dispatch.js). Missing = still at the packing slip step.
  dq: {
    step: String, // slip | packed | handover | done
    stepAt: Date, // when the current step began: its deadline is counted from here
    slip: { at: Date, byName: String, byId: String, dueAt: Date, late: Boolean },
    packed: { at: Date, byName: String, byId: String, awb: String, courier: String, photoId: String, photoIds: [String], dueAt: Date, late: Boolean }, // photoIds: every photo of the package (photoId = the first)
    handover: { at: Date, byName: String, byId: String, manifestId: String, manifestIds: [String], dueAt: Date, late: Boolean }, // manifestIds: every photo of the manifest
  },
  // Who has to work this order right now (see lib/assign.js). slot is the column it was given for: when the order moves to the next column it is shared out again.
  assignee: { id: String, name: String, slot: String, at: Date, by: String, auto: Boolean },
  restoredAt: Date,
  rev: { type: Number, default: 0 }, // bumps on every change: two people cannot both act on the same card
  log: [{ _id: false, at: Date, by: String, byId: String, action: String, stage: String, fu: String, label: String, whatsappShared: Boolean, reason: String, amount: Number }],
}, { timestamps: true, minimize: false });
deskOrderSchema.index({ stage: 1, fuNo: 1, dueAt: 1 });
deskOrderSchema.index({ 'assignee.id': 1, stage: 1 });
deskOrderSchema.index({ 'dq.packed.awb': 1 }, { sparse: true }); // "is this AWB already on another order?"
const DeskOrder = mongoose.model('DeskOrder', deskOrderSchema);

// Payment screenshots (partial payments). Kept in MongoDB so they survive redeploys on hosts with a temporary disk.
const DeskShot = mongoose.model('DeskShot', new Schema({
  orderId: { type: Number, index: true },
  mime: String, size: Number, sha256: String, data: Buffer,
  byName: String, at: { type: Date, default: Date.now },
}, { versionKey: false }));

// Dispatch queue proofs: photo of the packed package (one order) and photo of the manifest (one photo can cover many orders).
const DispatchProof = mongoose.model('DispatchProof', new Schema({
  kind: { type: String, enum: ['package', 'manifest'], index: true },
  orderId: { type: Number, index: true }, // package photos
  orderIds: [Number], // manifest photos: every order handed over with this manifest
  mime: String, size: Number, sha256: String, data: Buffer,
  byName: String, at: { type: Date, default: Date.now },
}, { versionKey: false }));

// ---------------------------------------------------------------------------------------------
// Courier problem cases: NDR (customer follow-ups), weight discrepancy (3 steps) and RTO "received" ticks. One document per order and type.
// ---------------------------------------------------------------------------------------------
const shipCaseSchema = new Schema({
  type: { type: String, enum: ['ndr', 'weight', 'rto'], index: true },
  orderId: { type: Number, index: true },
  status: { type: String, default: 'open', index: true }, // open | resolved   (rto: always open; `received` is the tick)
  step: { type: Number, default: 1 }, // ndr: FU1-3. weight: 1 review, 2 submit on Shipway, 3 final resolution
  dueAt: Date, // ndr only
  openedAt: { type: Date, default: Date.now },
  source: String, // shipway | upload | manual
  awb: String, courier: String,
  ndr: { reason: String, statusCode: String, raisedAt: Date },
  weight: { declaredG: Number, chargedG: Number, diffG: Number, extraCharge: Number, raisedAt: Date, batch: String },
  requestRef: String, requestAt: Date,
  resolution: { outcome: String, at: Date, by: String, note: String, amount: Number },
  received: { at: Date, by: String, byId: String, note: String }, // rto
  log: [{ _id: false, at: Date, by: String, byId: String, step: Number, action: String, label: String, note: String }],
  rev: { type: Number, default: 0 },
}, { timestamps: true, minimize: false });
shipCaseSchema.index({ type: 1, orderId: 1, status: 1 });
shipCaseSchema.index({ type: 1, status: 1, step: 1, dueAt: 1 });
const ShipCase = mongoose.model('ShipCase', shipCaseSchema);

module.exports = { ShipCase, DeskOrder, DeskShot, DispatchProof, StaffUser, OrderFlow, FlowEvent, FlowProof, Snapshot, ShopifyDate, ShopifyOrder, ShipwayShipment, Order, SyncRun, Setting };
