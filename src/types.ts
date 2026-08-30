export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
}

export interface Vehicle {
  id: string;
  model: string;
  licensePlate: string;
  year?: number;
}

export interface WorkOrderItem {
  id: string;
  workOrderId: string;
  articleId?: string | null;
  code: string;
  description: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface WorkOrder {
  id: string;
  number: string;
  status: string;
  customerId: string;
  vehicleId: string;
  component: string;
  employeeId?: string;
  employeeName?: string;
  createdAt: string;
  updatedAt: string;
  items?: WorkOrderItem[];
  customer?: Customer;
  vehicle?: Vehicle;
}

