import React from 'react';
import { HashRouter, BrowserRouter, Routes, Route } from 'react-router-dom';
import { isNativeApp, setupNativeApp } from './lib/native';
import { MainLayout } from './components/MainLayout';
import { RequireAuth } from './components/RequireAuth';
import { AuthProvider } from './lib/auth';
import { Customers } from './pages/Customers';
import { Dashboard } from './pages/Dashboard';
import { Employees } from './pages/Employees';
import { InvoiceDetails } from './pages/InvoiceDetails';
import { InvoiceNew } from './pages/InvoiceNew';
import { Invoices } from './pages/Invoices';
import { Inventory } from './pages/Inventory';
import { Login } from './pages/Login';
import { Notifications } from './pages/Notifications';
import { PriceLists } from './pages/PriceLists';
import { PublicQuotation } from './pages/PublicQuotation';
import { QuotationDetails } from './pages/QuotationDetails';
import { Quotations } from './pages/Quotations';
import { Settings } from './pages/Settings';
import { Suppliers } from './pages/Suppliers';
import { Vehicles } from './pages/Vehicles';
import { WorkOrderDetails } from './pages/WorkOrderDetails';
import { ClientPortal } from './pages/ClientPortal';

/**
 * En Android la app se sirve desde el sistema de archivos, donde las rutas
 * tipo /cotizaciones no existen como recurso. HashRouter las resuelve sin
 * depender del servidor. En la web se mantiene BrowserRouter y las URLs
 * quedan iguales que siempre.
 */
const Router = isNativeApp ? HashRouter : BrowserRouter;

export default function App() {
  React.useEffect(() => {
    // Devuelve false: no interceptamos el botón de volver, deja que el
    // historial de navegación haga su trabajo.
    setupNativeApp(() => false);
  }, []);

  return (
    <Router>
      <AuthProvider>
        <Routes>
          {/* Client Portal Route (público, sin login) */}
          <Route path="/seguimiento/:id" element={<ClientPortal />} />

          {/* Presupuesto que el cliente acepta o rechaza (público, con token) */}
          <Route path="/presupuesto/:token" element={<PublicQuotation />} />

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
                    <Route path="/facturas" element={<Invoices />} />
                    <Route path="/facturar/:otNumber" element={<InvoiceNew />} />
                    <Route path="/factura/:id" element={<InvoiceDetails />} />
                    <Route path="/configuracion" element={<Settings />} />
                    <Route path="/inventario" element={<Inventory />} />
                    <Route path="/listas-precios" element={<PriceLists />} />
                    <Route path="/mensajes" element={<Notifications />} />
                    <Route path="/clientes" element={<Customers />} />
                    <Route path="/vehiculos" element={<Vehicles />} />
                    <Route path="/proveedores" element={<Suppliers />} />
                    <Route path="/empleados" element={<Employees />} />
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
