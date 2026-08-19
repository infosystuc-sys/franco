import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { MainLayout } from './components/MainLayout';
import { RequireAuth } from './components/RequireAuth';
import { AuthProvider } from './lib/auth';
import { Customers } from './pages/Customers';
import { Dashboard } from './pages/Dashboard';
import { Inventory } from './pages/Inventory';
import { Login } from './pages/Login';
import { PriceLists } from './pages/PriceLists';
import { QuotationDetails } from './pages/QuotationDetails';
import { Quotations } from './pages/Quotations';
import { Suppliers } from './pages/Suppliers';
import { Vehicles } from './pages/Vehicles';
import { WorkOrderDetails } from './pages/WorkOrderDetails';
import { ClientPortal } from './pages/ClientPortal';

export default function App() {
  return (
    <Router>
      <AuthProvider>
        <Routes>
          {/* Client Portal Route (público, sin login) */}
          <Route path="/seguimiento/:id" element={<ClientPortal />} />

          {/* Login (público) */}
          <Route path="/login" element={<Login />} />

          {/* Internal Routes with MainLayout, requieren sesión iniciada */}
          <Route
            path="/*"
            element={
              <RequireAuth>
                <MainLayout>
                  <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/orden/:id" element={<WorkOrderDetails />} />
                    <Route path="/cotizaciones" element={<Quotations />} />
                    <Route path="/cotizacion/:number" element={<QuotationDetails />} />
                    <Route path="/inventario" element={<Inventory />} />
                    <Route path="/listas-precios" element={<PriceLists />} />
                    <Route path="/clientes" element={<Customers />} />
                    <Route path="/vehiculos" element={<Vehicles />} />
                    <Route path="/proveedores" element={<Suppliers />} />
                    <Route path="/ordenes" element={<Dashboard />} /> {/* Placeholder */}
                    {/* Fallback */}
                    <Route path="*" element={<Dashboard />} />
                  </Routes>
                </MainLayout>
              </RequireAuth>
            }
          />
        </Routes>
      </AuthProvider>
    </Router>
  );
}
