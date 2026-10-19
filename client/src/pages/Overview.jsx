import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api.js';
import { useStaff } from '../staff.jsx';
import { useFilters } from '../filters.jsx';
import { FilterBar, Funnel, KpiCard, Loading, MixCard, ModeTabs } from '../components.jsx';
import { KPIS } from '../format.js';
import TeamPerformance from './TeamPerformance.jsx';

export default function Overview() {
  const f = useFilters();
  const { user } = useStaff();
  const team = !!user && user.role !== 'admin'; // confirmation / packing: same layout, only their own rates, no money
  const { data, error, loading } = useApi(team ? '/desk/my-overview' : '/metrics', f.params, f.ready);
  const [mode, setMode] = useState('All');
  const empty = data && data.current.All.total === 0;
  return (
    <>
      <FilterBar range={data && data.range} undated={data && data.undated} />
      <div className="page">
        <h1>Overview</h1>
        <p className="lede">Every number is counted by order date, so a window always describes the same set of orders. Hover a percentage to see its numerator and denominator.</p>
        <Loading error={error} loading={loading || !f.ready}>
          {data && data.current.All.total === 0 && (
            <div className="banner">No orders in this window. {data.undated > 0 ? 'Undated orders only appear under All time. ' : ''}Try a wider window, {team ? '' : <>or check <Link to="/issues">Data issues</Link>.</>}</div>
          )}
          {data && !empty && data.current.All.shipments > 0 && data.current.All.closed < data.current.All.shipments * 0.6 && (
            <div className="banner warn">Only {data.current.All.closed} of {data.current.All.shipments} shipments in this window have closed. RTO and Delivered rates will move as the rest land.</div>
          )}
          {data && (
            <>
              <div className="grid">
                {KPIS.filter((k) => !team || (data.kpis || []).includes(k.key)).map((k) => <KpiCard key={k.key} kpi={k} current={data.current} previous={data.previous} />)}
                {!team && <MixCard current={data.current} />}
              </div>
              <div className="section card">
                <div className="filters" style={{ justifyContent: 'space-between' }}>
                  <h2 style={{ margin: 0 }}>Order funnel</h2>
                  <ModeTabs value={mode} onChange={setMode} />
                </div>
                <Funnel block={data.current[mode] || data.current.All} />
              </div>
              {!team && <TeamPerformance />}
            </>
          )}
        </Loading>
      </div>
    </>
  );
}
