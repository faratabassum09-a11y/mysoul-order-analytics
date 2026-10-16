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
const OrderFlow = mongoose.model('OrderFlow', new Schema({
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
}, { timestamps: true, minimize: false }));
OrderFlow.index({ awb: 1 }, { unique: true, partialFilterExpression: { awb: { $type: 'string' } } }); // one AWB, one order

// Append-only history. There is no route that edits or deletes a row here.
const FlowEvent = mongoose.model('FlowEvent', new Schema({
  orderId: { type: Number, index: true },
  at: { type: Date, default: Date.now, index: true },
  byId: String, byName: String, role: String,
  stage: String, // confirm | dispatch | contact
  action: String, // confirm | partial_pay | cancel | no_answer | auto_cancel | escalate | call | whatsapp | partial_link | slip_printed | packed | ready | dispatched | delay_reason | proof_added
  previous: String, next: String, // status before and after (the "previous status" every log must carry)
  label: String, // plain-language line for the timeline
  reasonKey: String,
  meta: Schema.Types.Mixed,
}, { minimize: false, versionKey: false }));
FlowEvent.index({ orderId: 1, at: 1 });

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

module.exports = { StaffUser, OrderFlow, FlowEvent, FlowProof, Snapshot, ShopifyDate, ShopifyOrder, ShipwayShipment, Order, SyncRun, Setting };
