import React from 'react';
import { HashRouter, BrowserRouter, Routes, Route } from 'react-router-dom';
import { isNativeApp, setupNativeApp } from './lib/native';
import { MainLayout } from './components/MainLayout';
import { RequireAuth } from './components/RequireAuth';
import { AuthProvider } from './lib/auth';
import { Customers } from './pages/Customers';
import { Dashboard } from './pages/Dashboard';
import { WorkOrders } from './pages/WorkOrders';
import { Users } from './pages/Users';
import { ExpenseConcepts } from './pages/ExpenseConcepts';
import { InvoiceDetails } from './pages/InvoiceDetails';
import { InvoiceNew } from './pages/InvoiceNew';
import { Invoices } from './pages/Invoices';
import { InvoiceNewFree } from './pages/InvoiceNewFree';
import { Inventory } from './pages/Inventory';
import { Login } from './pages/Login';
import { Notifications } from './pages/Notifications';
import { PriceLists } from './pages/PriceLists';
import { PublicQuotation } from './pages/PublicQuotation';
import { QuotationDetails } from './pages/QuotationDetails';
import { PaymentMethods } from './pages/PaymentMethods';
import { Checks } from './pages/Checks';
import { PaymentOrderDetails } from './pages/PaymentOrderDetails';
import { PaymentOrderNew } from './pages/PaymentOrderNew';
import { PaymentOrders } from './pages/PaymentOrders';
import { ReceiptDetails } from './pages/ReceiptDetails';
import { ReceiptNew } from './pages/ReceiptNew';
import { Receipts } from './pages/Receipts';
import { Treasury } from './pages/Treasury';
import { PurchaseDetails } from './pages/PurchaseDetails';
import { PurchaseNew } from './pages/PurchaseNew';
import { Purchases } from './pages/Purchases';
import { Quotations } from './pages/Quotations';
import { VehicleIntakes } from './pages/VehicleIntakes';
import { VehicleIntakeDetails } from './pages/VehicleIntakeDetails';
import { ReportView } from './pages/ReportView';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { Suppliers } from './pages/Suppliers';
import { TaxRates } from './pages/TaxRates';
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
                    <Route path="/ingresos" element={<VehicleIntakes />} />
                    <Route path="/ingresos/:id" element={<VehicleIntakeDetails />} />
                    <Route path="/cotizaciones" element={<Quotations />} />
                    <Route path="/cotizacion/:number" element={<QuotationDetails />} />
                    <Route path="/facturas" element={<Invoices />} />
                    <Route path="/facturas/nueva" element={<InvoiceNewFree />} />
                    <Route path="/facturar/:otNumber" element={<InvoiceNew />} />
                    <Route path="/factura/:id" element={<InvoiceDetails />} />
                    <Route path="/compras" element={<Purchases />} />
                    <Route path="/compras/nueva/:kind" element={<PurchaseNew />} />
                    <Route path="/compra/:id" element={<PurchaseDetails />} />
                    <Route path="/informes" element={<Reports />} />
                    <Route path="/informe/:id" element={<ReportView />} />
                    <Route path="/cobranzas" element={<Receipts />} />
                    <Route path="/cobranzas/nueva" element={<ReceiptNew />} />
                    <Route path="/recibo/:id" element={<ReceiptDetails />} />
                    <Route path="/pagos" element={<PaymentOrders />} />
                    <Route path="/pagos/nueva" element={<PaymentOrderNew />} />
                    <Route path="/pago/:id" element={<PaymentOrderDetails />} />
                    <Route path="/tesoreria" element={<Treasury />} />
                    <Route path="/cheques" element={<Checks />} />
                    <Route path="/medios-pago" element={<PaymentMethods />} />
                    <Route path="/alicuotas" element={<TaxRates />} />
                    <Route path="/conceptos" element={<ExpenseConcepts />} />
                    <Route path="/configuracion" element={<Settings />} />
                    <Route path="/inventario" element={<Inventory />} />
                    <Route path="/listas-precios" element={<PriceLists />} />
                    <Route path="/mensajes" element={<Notifications />} />
                    <Route path="/clientes" element={<Customers />} />
                    <Route path="/vehiculos" element={<Vehicles />} />
                    <Route path="/proveedores" element={<Suppliers />} />
                    <Route path="/usuarios" element={<Users />} />
                    <Route path="/ordenes" element={<WorkOrders />} />
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
