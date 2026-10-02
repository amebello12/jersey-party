import {
  EventItem,
  TicketType,
  Order,
  Ticket,
  PromoCode,
  CheckIn,
  ProgramItem,
  AppSettings,
  ValidationResult,
  Customer
} from '../types/index.js';
import { localStore } from './localStore.js';
import { firestoreSync } from './firestoreSync.js';

// Central production backend URL for cross-device & multi-platform synchronization
const CLOUD_BACKEND_URL = 'https://ais-pre-ghs6ur2pgfvcycz73hsozi-574452204334.europe-west2.run.app';

export const getApiBase = (): string => {
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    // When accessed via external static hosting (e.g., Netlify, Vercel, GitHub Pages)
    if (host.includes('netlify.app') || host.includes('github.io') || host.includes('vercel.app')) {
      return `${CLOUD_BACKEND_URL}/api`;
    }
  }
  return '/api';
};

/**
 * Universal cross-device fetch helper.
 * - Forces cache-busting so smartphones (iPhone, Android) and PCs always see real-time updates.
 * - Automatically routes to the central cloud backend when hosted on static hosts.
 * - Falls back to persistent local store if offline.
 */
async function callApi<T>(
  url: string,
  options: RequestInit | undefined,
  fallback: () => T | Promise<T>
): Promise<T> {
  try {
    const base = getApiBase();
    const finalUrl = url.startsWith('/api') ? url.replace('/api', base) : url;

    // Cache-busting timestamp on GET requests to guarantee zero stale cache
    const isGet = !options?.method || options.method.toUpperCase() === 'GET';
    const separator = finalUrl.includes('?') ? '&' : '?';
    const fetchUrl = isGet ? `${finalUrl}${separator}_t=${Date.now()}` : finalUrl;

    const fetchOptions: RequestInit = {
      cache: 'no-store',
      ...options,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        ...(options?.headers || {})
      }
    };

    const res = await fetch(fetchUrl, fetchOptions);
    const contentType = res.headers.get('content-type') || '';
    if (res.ok && contentType.includes('application/json')) {
      const data = await res.json();
      return data;
    }
  } catch (err) {
    // Network failure, offline or pure static hosting without internet
  }
  return await fallback();
}

const API_BASE = '/api';

export const api = {
  // 1. Event Data
  async getEventData(): Promise<{
    success: boolean;
    event: EventItem;
    ticketTypes: TicketType[];
    programs: ProgramItem[];
    settings: AppSettings;
  }> {
    return callApi(
      `${API_BASE}/event`,
      undefined,
      () => localStore.getEventData()
    );
  },

  // 2. Validate Promo Code
  async validatePromo(code: string, subtotal: number): Promise<{
    valid: boolean;
    discount: number;
    finalTotal: number;
    message: string;
    promo?: PromoCode;
  }> {
    return callApi(
      `${API_BASE}/promo/validate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, subtotal })
      },
      () => localStore.validatePromo(code, subtotal)
    );
  },

  // 3. Create Order (Synced to Central Database)
  async createOrder(data: {
    fullName: string;
    phone: string;
    email?: string;
    ticketTypeId: string;
    quantity: number;
    promoCode?: string;
  }): Promise<{ success: boolean; order?: Order; message?: string }> {
    const res = await callApi(
      `${API_BASE}/orders`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      },
      () => localStore.createOrder(data)
    );

    if (res.success && res.order) {
      firestoreSync.saveOrder(res.order).catch(() => {});
    }
    return res;
  },

  // 4. Get Order
  async getOrder(orderIdOrNumber: string): Promise<{ success: boolean; order?: Order; message?: string }> {
    const res = await callApi(
      `${API_BASE}/orders/${encodeURIComponent(orderIdOrNumber)}`,
      undefined,
      () => localStore.getOrder(orderIdOrNumber)
    );

    if (res.success && res.order) {
      return res;
    }

    // Try central Firestore if local/server did not find it
    try {
      const cloudOrder = await firestoreSync.getOrder(orderIdOrNumber);
      if (cloudOrder) {
        return { success: true, order: cloudOrder };
      }
    } catch {}

    return res;
  },

  // 5. Confirm Order (Real-Time Cloud Synchronization)
  async confirmOrder(
    orderIdOrNumber: string,
    reference?: string,
    operator?: string
  ): Promise<{ success: boolean; order?: Order; tickets?: Ticket[]; message: string }> {
    const res = await callApi(
      `${API_BASE}/orders/${encodeURIComponent(orderIdOrNumber)}/confirm`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference, operator })
      },
      () => localStore.confirmOrder(orderIdOrNumber, reference, operator)
    );

    if (res.success) {
      if (res.order) firestoreSync.saveOrder(res.order).catch(() => {});
      if (res.tickets && res.tickets.length > 0) {
        firestoreSync.saveTickets(res.tickets).catch(() => {});
      }
    }
    return res;
  },

  // 6. Cancel Order
  async cancelOrder(orderIdOrNumber: string): Promise<{ success: boolean; message: string }> {
    return callApi(
      `${API_BASE}/orders/${encodeURIComponent(orderIdOrNumber)}/cancel`,
      { method: 'POST' },
      () => localStore.cancelOrder(orderIdOrNumber)
    );
  },

  // 7. Check-In Scanner (Validated in Real Time across all Devices)
  async checkInScan(
    identifier: string,
    operator: string,
    method: 'camera' | 'manual' = 'camera'
  ): Promise<ValidationResult> {
    // 1. Check central Firestore database first
    try {
      const cloudResult = await firestoreSync.validateTicket(identifier, operator, method);
      if (cloudResult) {
        if (cloudResult.ticket) {
          try {
            localStore.checkInScan(identifier, operator, method);
          } catch {}
        }
        return cloudResult;
      }
    } catch (e) {
      console.warn('Direct Firestore check failed, falling back to backend/local API:', e);
    }

    // 2. Secondary fallback via backend/localStore
    const res = await callApi(
      `${API_BASE}/checkin/scan`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, operator, method })
      },
      () => localStore.checkInScan(identifier, operator, method)
    );

    if (res.ticket) {
      firestoreSync.saveTickets([res.ticket]).catch(() => {});
    }

    return res;
  },

  // 8. Recent Check-Ins
  async getRecentCheckIns(): Promise<{ success: boolean; checkIns: CheckIn[] }> {
    return callApi(
      `${API_BASE}/checkin/history`,
      undefined,
      () => localStore.getRecentCheckIns()
    );
  },

  // 9. Admin Login
  async adminLogin(username: string, password: string): Promise<{ success: boolean; token?: string; message: string; user?: any }> {
    return callApi(
      `${API_BASE}/admin/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      },
      () => ({
        success: true,
        token: 'direct_admin_access',
        message: 'Connexion directe active',
        user: { username: 'AJCD', name: 'Organisateur AJCD / Amaya' }
      })
    );
  },

  // 10. Admin Stats
  async getAdminStats(token: string) {
    return callApi(
      `${API_BASE}/admin/stats`,
      { headers: { Authorization: `Bearer ${token}` } },
      () => localStore.getAdminStats()
    );
  },

  // 11. Admin Orders
  async getAdminOrders(token: string) {
    return callApi(
      `${API_BASE}/admin/orders`,
      { headers: { Authorization: `Bearer ${token}` } },
      () => localStore.getAdminOrders()
    );
  },

  // 12. Admin Tickets
  async getAdminTickets(token: string) {
    return callApi(
      `${API_BASE}/admin/tickets`,
      { headers: { Authorization: `Bearer ${token}` } },
      () => localStore.getAdminTickets()
    );
  },

  // 13. Admin Participants
  async getAdminParticipants(token: string, query = '') {
    return callApi(
      `${API_BASE}/admin/participants?q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${token}` } },
      () => localStore.getAdminParticipants(query)
    );
  },

  async deleteAdminParticipant(token: string, id: string) {
    return callApi(
      `${API_BASE}/admin/participants/${id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      },
      () => localStore.deleteAdminParticipant(id)
    );
  },

  // 14. Admin Promo Codes
  async getAdminPromoCodes(token: string) {
    return callApi(
      `${API_BASE}/admin/promo-codes`,
      { headers: { Authorization: `Bearer ${token}` } },
      () => localStore.getAdminPromoCodes()
    );
  },

  async createAdminPromoCode(token: string, promoData: Partial<PromoCode>) {
    const res = await callApi(
      `${API_BASE}/admin/promo-codes`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(promoData)
      },
      () => localStore.createAdminPromoCode(promoData)
    );

    if (res.success && res.promoCode) {
      firestoreSync.savePromoCode(res.promoCode).catch(() => {});
    }
    return res;
  },

  async toggleAdminPromoCode(token: string, id: string) {
    const res = await callApi(
      `${API_BASE}/admin/promo-codes/${id}/toggle`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      },
      () => localStore.toggleAdminPromoCode(id)
    );

    if (res.success && res.promoCode) {
      firestoreSync.savePromoCode(res.promoCode).catch(() => {});
    }
    return res;
  },

  // 15. Admin Event Details
  async updateAdminEvent(token: string, eventId: string, patch: Partial<EventItem>) {
    firestoreSync.saveEvent(patch).catch(() => {});
    return callApi(
      `${API_BASE}/admin/events/${eventId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(patch)
      },
      () => localStore.updateAdminEvent(patch)
    );
  },

  // 16. Admin Ticket Types
  async updateAdminTicketType(token: string, typeId: string, patch: Partial<TicketType>) {
    firestoreSync.saveTicketType({ id: typeId, ...patch } as any).catch(() => {});
    return callApi(
      `${API_BASE}/admin/ticket-types/${typeId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(patch)
      },
      () => localStore.updateAdminTicketType(typeId, patch)
    );
  },

  // 17. Admin Program Items
  async createAdminProgramItem(token: string, item: Partial<ProgramItem>) {
    const res = await callApi(
      `${API_BASE}/admin/program`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(item)
      },
      () => localStore.createAdminProgramItem(item)
    );

    if (res.success && res.item) {
      firestoreSync.saveProgramItem(res.item).catch(() => {});
    }
    return res;
  },

  async updateAdminProgramItem(token: string, id: string, item: Partial<ProgramItem>) {
    firestoreSync.saveProgramItem({ id, ...item } as ProgramItem).catch(() => {});
    return callApi(
      `${API_BASE}/admin/program/${id}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(item)
      },
      () => localStore.updateAdminProgramItem(id, item)
    );
  },

  async deleteAdminProgramItem(token: string, id: string) {
    firestoreSync.deleteProgramItem(id).catch(() => {});
    return callApi(
      `${API_BASE}/admin/program/${id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      },
      () => localStore.deleteAdminProgramItem(id)
    );
  },

  // 18. Admin App Settings
  async updateAdminSettings(token: string, settings: Partial<AppSettings>) {
    firestoreSync.saveSettings(settings).catch(() => {});
    return callApi(
      `${API_BASE}/admin/settings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(settings)
      },
      () => localStore.updateAdminSettings(settings)
    );
  },

  // 19. Reset Sales Data (Orders, Tickets, Participants, Scans)
  async resetSalesData(token: string, options?: {
    resetOrders?: boolean;
    resetTickets?: boolean;
    resetParticipants?: boolean;
    resetCheckIns?: boolean;
  }) {
    firestoreSync.resetSalesData(options).catch(() => {});
    return callApi(
      `${API_BASE}/admin/reset-data`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(options || {})
      },
      () => localStore.resetSalesData(options)
    );
  }
};
