const mongoose = require('mongoose');
const { Schema } = mongoose;

// Last raw copy of each source tab, so cleaning can be re-run without re-fetching.
const Snapshot = mongoose.model('Snapshot', new Schema({
  tab: { type: String, unique: true }, // 'order' | 'master'
  rows: Schema.Types.Mixed,
  source: String,
  fetchedAt: Date,
}));

// One-time Shopify CSV backfill (file upload, not the Step 2 API).
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
  excluded: { type: String, default: null, index: true }, // null | noid | duplicate | test
  excludedReason: String, duplicateOf: Number,
  conflicts: [String],
  log: [String],
  raw: [String],
}, { minimize: false }));

const SyncRun = mongoose.model('SyncRun', new Schema({
  at: { type: Date, default: Date.now },
  trigger: String, // manual | auto | upload | shopify-upload | settings
  source: String,
  ok: Boolean,
  error: String,
  summary: Schema.Types.Mixed,
  warnings: [String],
}));

const Setting = mongoose.model('Setting', new Schema({
  key: { type: String, unique: true },
  value: Schema.Types.Mixed,
}));

module.exports = { Snapshot, ShopifyDate, Order, SyncRun, Setting };
