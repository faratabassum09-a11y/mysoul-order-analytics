import React, { useState } from 'react';
import { useApi } from '../api.js';
import { useFilters } from '../filters.jsx';
import { FilterBar, Loading } from '../components.jsx';
import { MODES, inr, int, pct, ratioTitle } from '../format.js';

const GROUPS = [
  ['campaign', 'Campaign'], ['adset', 'Ad set'], ['ad', 'Ad'], ['theme', 'Theme'], ['source', 'Source'], ['landing', 'Landing product'], ['device', 'Device'],
];
const HINT = {
  campaign: 'utm_campaign', adset: 'utm_medium (Meta puts the ad set name here)', ad: 'utm_content (the ad name)',
  theme: 'First part of the campaign name, before the first "|"', source: 'utm_source, Meta grouped together', landing: 'Product page the customer landed on', device: 'From the browser string in the order',
};

const WHY = {
  no_shopify_orders: 'No orders have been pulled from Shopify. Open Settings, Shopify, check it says connected, press Test connection, then Load all orders.',
  not_reloaded: 'Shopify orders were stored before the UTM fields existed. Open Settings, Shopify, and press Load all orders once.',
  no_match: 'Shopify orders are stored, but none are from this window. Try a longer window, and check Shopify is up to date (Settings, Sync now).',
  no_utm_on_orders: 'These orders were found in Shopify but carry no UTM fields. Press Test connection in Settings to see what Shopify sends for the newest order.',
};

export default function Campaigns() {
  const f = useFilters();
  const [by, setBy] = useState('campaign');
  const [mode, setMode] = useState('');
  const [min, setMin] = useState(1);
  const { data, error, loading } = useApi('/campaigns', { ...f.params, by, mode }, f.ready);
  const rows = data ? data.rows.filter((r) => r.unattributed || r.orders >= min) : [];
  const hidden = data ? data.rows.length - rows.length : 0;
  const t = data && data.totals;
  return (
    <>
      <FilterBar range={data && data.range} />
      <div className="page">
        <h1>Campaigns</h1>
        <p className="lede">Where orders come from (UTM fields in the Shopify order), and what happens to them after: confirmed, delivered or returned.</p>
        <div className="filters">
          <div className="seg" role="tablist">{GROUPS.map(([k, l]) => <button key={k} className={by === k ? 'on' : ''} onClick={() => setBy(k)} title={HINT[k]}>{l}</button>)}</div>
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Payment mode"><option value="">All payment modes</option>{MODES.map((m) => <option key={m}>{m}</option>)}</select>
          <select value={min} onChange={(e) => setMin(Number(e.target.value))} aria-label="Minimum orders"><option value={1}>Any number of orders</option><option value={5}>At least 5 orders</option><option value={10}>At least 10 orders</option><option value={25}>At least 25 orders</option></select>
        </div>
        <Loading error={error} loading={loading || !f.ready}>
          {data && (
            <>
              {data.why && <div className="banner warn"><b>No UTM data found.</b> {WHY[data.why]}{data.shopifyRunning && <> A Shopify sync is running right now, so check again in a few minutes.</>}
                <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{int(data.total)} orders in this window · {int(data.matched)} found in Shopify · {int(data.shopifyOrders)} Shopify orders stored · {int(data.marketingLoaded)} of them with UTM fields loaded{data.shopifyLast ? ` · last Shopify sync ${data.shopifyLast.ok ? 'ok' : 'failed'}${data.shopifyLast.error ? `: ${data.shopifyLast.error}` : ''}` : ''}</div></div>}
              {!data.why && data.total > 0 && (
                <div className={`banner${data.coverage < 70 ? ' warn' : ''}`}>
                  <b>{pct(data.coverage, 0)}</b> of the {int(data.total)} orders in this window carry UTM data ({int(data.withUtm)}). The rest are direct visits, older than Shopify's 60-day limit, or not yet synced.
                </div>
              )}
              {data.total === 0 ? <div className="empty">No orders in this window.</div> : (
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{GROUPS.find((g) => g[0] === by)[1]}</th>
                        <th className="num">Orders</th><th className="num">Share</th><th className="num">COD</th>
                        <th className="num">Order value</th><th className="num">Confirmed</th><th className="num">Cancelled</th>
                        <th className="num">RTO</th><th className="num">Delivered</th><th className="num">Net delivered</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key} className={r.unattributed ? 'muted' : ''}>
                          <td style={{ whiteSpace: 'normal', minWidth: 220 }} title={r.key}>
                            {r.key}
                            {r.campaign && <div className="muted" style={{ fontSize: 12 }}>{r.campaign}</div>}
                          </td>
                          <td className="num">{int(r.orders)}</td>
                          <td className="num">{pct(r.share, 0)}</td>
                          <td className="num" title={`${int(r.cod)} COD · ${int(r.prepaid)} prepaid`}>{pct(r.codShare, 0)}</td>
                          <td className="num">{inr(r.value)}</td>
                          <td className="num" title={ratioTitle(r.confirmation)}>{pct(r.confirmation.v)}</td>
                          <td className="num" title={ratioTitle(r.cancellation)}>{pct(r.cancellation.v)}</td>
                          <td className="num" title={`${ratioTitle(r.rto)} closed shipments · ${int(r.inTransit)} still in transit`}>{pct(r.rto.v)}</td>
                          <td className="num" title={ratioTitle(r.deliveredRate)}>{int(r.delivered)}</td>
                          <td className="num">{inr(r.netRevenue)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td><b>All orders</b></td><td className="num"><b>{int(t.orders)}</b></td><td className="num">100%</td><td className="num" />
                        <td className="num"><b>{inr(t.value)}</b></td><td className="num"><b>{pct(t.confirmation.v)}</b></td><td className="num"><b>{pct(t.cancellation.v)}</b></td>
                        <td className="num"><b>{pct(t.rto.v)}</b></td><td className="num"><b>{int(t.delivered)}</b></td><td className="num"><b>{inr(t.netRevenue)}</b></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
              <p className="muted" style={{ marginTop: 10 }}>
                RTO is returned ÷ (delivered + returned) and only counts shipments that have closed, so recent campaigns look better than they will end up. Hover a number for the counts behind it.
                {hidden > 0 && ` ${hidden} row${hidden > 1 ? 's' : ''} with fewer orders hidden.`}
              </p>
            </>
          )}
        </Loading>
      </div>
    </>
  );
}
