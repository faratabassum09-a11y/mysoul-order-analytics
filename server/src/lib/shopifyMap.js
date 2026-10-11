// Turns one Shopify GraphQL order node into the flat document we store. Pure: no network, no database.
const money = (set) => {
  const v = set && set.shopMoney && set.shopMoney.amount;
  return v === undefined || v === null || v === '' ? null : Number(v);
};

// "#1300" -> 1300. Also copes with a store prefix/suffix such as "MS-1300".
function orderIdFromName(name) {
  const m = String(name || '').match(/(\d+)\s*\D*$/);
  return m ? Number(m[1]) : null;
}

function normalizeOrder(n) {
  const orderId = orderIdFromName(n.name);
  if (orderId === null) return null;
  const items = ((n.lineItems && n.lineItems.nodes) || []).map((li) => ({
    title: li.title || '',
    variantTitle: li.variantTitle && li.variantTitle !== 'Default Title' ? li.variantTitle : '',
    sku: li.sku || '',
    quantity: li.currentQuantity === undefined || li.currentQuantity === null ? li.quantity : li.currentQuantity, // after edits/refunds
    orderedQuantity: li.quantity,
    price: money(li.originalUnitPriceSet),
  }));
  const ship = n.shippingAddress || {};
  const c = n.customer || {};
  const name = c.displayName || ship.name || null;
  return {
    orderId,
    shopifyId: n.id,
    name: n.name,
    createdAt: n.createdAt ? new Date(n.createdAt) : null,
    updatedAt: n.updatedAt ? new Date(n.updatedAt) : null,
    cancelledAt: n.cancelledAt ? new Date(n.cancelledAt) : null,
    test: !!n.test,
    financialStatus: n.displayFinancialStatus || '',
    fulfillmentStatus: n.displayFulfillmentStatus || '',
    paymentGateways: n.paymentGatewayNames || [],
    currency: n.currencyCode || '',
    subtotal: money(n.currentSubtotalPriceSet),
    shipping: money(n.totalShippingPriceSet),
    discounts: money(n.totalDiscountsSet),
    total: money(n.currentTotalPriceSet),
    note: n.note || '',
    tags: n.tags || [],
    customer: { name, email: c.email || n.email || null, phone: c.phone || ship.phone || n.phone || null },
    address: {
      name: ship.name || null, line1: ship.address1 || null, line2: ship.address2 || null, city: ship.city || null,
      state: ship.province || null, zip: ship.zip || null, country: ship.country || null, phone: ship.phone || null,
    },
    items,
    itemsSummary: items.filter((i) => i.quantity > 0).map((i) => `${i.title}${i.variantTitle ? ` (${i.variantTitle})` : ''} ×${i.quantity}`).join(', '),
  };
}

module.exports = { normalizeOrder, orderIdFromName, money };
