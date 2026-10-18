import React, { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from '../../api.js';
import { useToast } from '../../deskUi.jsx';
import { useStaff } from '../../staff.jsx';
import { LabelsProvider, notifyDesk, useDeskCounts, useLabels } from './shared.jsx';
import DeskOverview from './DeskOverview.jsx';
import DeskOrders from './DeskOrders.jsx';
import OrderAnalysis from './OrderAnalysis.jsx';
import { ConfirmQueue, PendingQueue } from './DeskQueue.jsx';
import { PartialPaid, CancelledOrders } from './DeskLists.jsx';
import DispatchBoard from './DispatchBoard.jsx';
import TransitOrders from './TransitOrders.jsx';
import DeskSettings from './DeskSettings.jsx';

// Tabs, in the order the team works an order: new orders, confirm calls, pending calls, dispatch (slip, packed, handover), in transit, then the side lists.
function tabsFor(role, c, L) {
  const n = (v) => (v ? v : null);
  const ALL = ['admin', 'confirmation', 'packing'];
  const all = [
    ['overview', L('tabOverview'), null, ['admin']],
    ['orders', L('tabOrders'), null, ALL],
    ['analysis', L('tabAnalysis'), null, ALL],
    ['confirm', L('tabConfirm'), c && n(c.confirm.total), ['admin', 'confirmation'], c && c.confirm.due],
    ['pending', L('tabPending'), c && n(c.pending.total), ['admin', 'confirmation'], c && c.pending.due],
    ['dispatch', L('tabDispatch'), c && n(c.dispatch), ['admin', 'packing'], c && c.dispatchSteps && c.dispatchSteps.overdue],
    ['transit', L('tabTransit'), null, ALL],
    ['partial', L('tabPartial'), c && n(c.partial), ['admin', 'confirmation']],
    ['cancelled', L('tabCancelled'), c && n(c.cancelled), ['admin', 'confirmation']],
    ['settings', L('tabSettings'), null, ['admin']],
  ];
  return all.filter((t) => t[3].includes(role));
}

export const deskHome = (user) => (user && user.role === 'packing' ? '/shopify-desk/dispatch' : user && user.role === 'confirmation' ? '/shopify-desk/confirm' : '/shopify-desk/overview');

function Refresh() {
  const [busy, setBusy] = useState(false);
  const [toast, show] = useToast();
  const go = async () => {
    setBusy(true);
    try { const r = await api.post('/desk/refresh'); notifyDesk(); window.dispatchEvent(new Event('desk-refresh')); show(r.added ? `${r.added} new order${r.added === 1 ? '' : 's'} added.` : 'Shopify checked. No new orders.'); }
    catch (e) { show(e.message, 'err'); } finally { setBusy(false); }
  };
  return <><button className="btn ghost" onClick={go} disabled={busy}>{busy ? 'Checking Shopify…' : 'Refresh from Shopify'}</button>{toast}</>;
}

export default function ShopifyDesk() { return <LabelsProvider><DeskInner /></LabelsProvider>; }

function DeskInner() {
  const { user } = useStaff();
  const { L } = useLabels();
  const counts = useDeskCounts();
  const tabs = tabsFor(user.role, counts, L);
  const allowed = new Set(tabs.map((t) => t[0]));
  const guard = (key, el) => (allowed.has(key) ? el : <Navigate to={deskHome(user)} replace />);
  return (
    <div className="sd">
      <div className="sd-top">
        <div>
          <h1>{L('deskTitle')}</h1>
          <p className="sd-sub">{L('deskSubtitle')}</p>
        </div>
        <Refresh />
      </div>
      <nav className="sd-tabs" aria-label="Shopify desk">
        {tabs.map(([key, label, count, , due]) => (
          <NavLink key={key} to={`/shopify-desk/${key}`} className={({ isActive }) => (isActive ? 'on' : '')}>
            {label}
            {count ? <span className={`sd-count ${due ? 'hot' : ''}`} title={due ? `${due} due now` : ''}>{count}</span> : null}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route path="overview" element={guard('overview', <DeskOverview />)} />
        <Route path="orders" element={<DeskOrders />} />
        <Route path="analysis" element={<OrderAnalysis />} />
        <Route path="confirm" element={guard('confirm', <ConfirmQueue />)} />
        <Route path="pending" element={guard('pending', <PendingQueue />)} />
        <Route path="dispatch" element={guard('dispatch', <DispatchBoard />)} />
        <Route path="transit" element={guard('transit', <TransitOrders />)} />
        <Route path="partial" element={guard('partial', <PartialPaid />)} />
        <Route path="cancelled" element={guard('cancelled', <CancelledOrders />)} />
        <Route path="settings" element={guard('settings', <DeskSettings />)} />
        <Route path="*" element={<Navigate to={deskHome(user)} replace />} />
      </Routes>
    </div>
  );
}
