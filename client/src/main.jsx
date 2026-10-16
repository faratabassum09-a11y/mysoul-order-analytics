import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { FilterProvider } from './filters.jsx';
import { StaffProvider } from './staff.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <StaffProvider>
      <FilterProvider>
        <App />
      </FilterProvider>
    </StaffProvider>
  </BrowserRouter>
);
