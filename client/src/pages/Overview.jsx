import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api.js';
import { useFilters } from '../filters.jsx';
import { FilterBar, Funnel, KpiCard, Loading, MixCard, ModeTabs } from '../components.jsx';
import { KPIS } from '../format.js';
import TeamPerformance from './TeamPerformance.jsx';

export default function Overview() {
  const f = useFilters();
  const { data, error, loading } = useApi('/metrics', f.params, f.ready);
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
            <div className="banner">No orders in this window. {data.undated > 0 ? 'Undated orders only appear under All time. ' : ''}Try a wider window, or check <Link to="/issues">Data issues</Link>.</div>
          )}
          {data && !empty && data.current.All.shipments > 0 && data.current.All.closed < data.current.All.shipments * 0.6 && (
            <div className="banner warn">Only {data.current.All.closed} of {data.current.All.shipments} shipments in this window have closed. RTO and Delivered rates will move as the rest land.</div>
          )}
          {data && (
            <>
              <div className="grid">
                {KPIS.map((k) => <KpiCard key={k.key} kpi={k} current={data.current} previous={data.previous} />)}
                <MixCard current={data.current} />
              </div>
              <div className="section card">
                <div className="filters" style={{ justifyContent: 'space-between' }}>
                  <h2 style={{ margin: 0 }}>Order funnel</h2>
                  <ModeTabs value={mode} onChange={setMode} />
                </div>
                <Funnel block={data.current[mode] || data.current.All} />
              </div>
              <TeamPerformance />
            </>
          )}
        </Loading>
      </div>
    </>
  );
}
