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

module.exports = { Snapshot, ShopifyDate, ShopifyOrder, ShipwayShipment, Order, SyncRun, Setting };
