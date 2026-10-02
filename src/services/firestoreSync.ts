import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  Unsubscribe,
  serverTimestamp
} from 'firebase/firestore';
import { db } from '../firebase/config.js';
import {
  Order,
  Ticket,
  CheckIn,
  EventItem,
  TicketType,
  ProgramItem,
  AppSettings,
  PromoCode,
  ValidationResult
} from '../types/index.js';

export const firestoreSync = {
  /**
   * Save an Order to the central Firestore database
   */
  async saveOrder(order: Order): Promise<void> {
    try {
      const docRef = doc(db, 'orders', order.order_number);
      await setDoc(docRef, {
        ...order,
        updated_at: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      console.warn('Firestore saveOrder error:', err);
    }
  },

  /**
   * Retrieve an Order and its tickets directly from Firestore
   */
  async getOrder(orderIdOrNumber: string): Promise<Order | null> {
    try {
      const clean = orderIdOrNumber.trim();
      const orderDoc = await getDoc(doc(db, 'orders', clean));
      if (orderDoc.exists()) {
        const orderData = orderDoc.data() as Order;
        if (!orderData.tickets || orderData.tickets.length === 0) {
          const qTickets = query(collection(db, 'tickets'), where('order_number', '==', clean));
          const snap = await getDocs(qTickets);
          const tickets: Ticket[] = [];
          snap.forEach(d => tickets.push(d.data() as Ticket));
          orderData.tickets = tickets;
        }
        return orderData;
      }
    } catch (err) {
      console.warn('Firestore getOrder error:', err);
    }
    return null;
  },

  /**
   * Save generated tickets with QR tokens to central Firestore
   */
  async saveTickets(tickets: Ticket[]): Promise<void> {
    try {
      await Promise.all(
        tickets.map(ticket => {
          const docRef = doc(db, 'tickets', ticket.ticket_number);
          return setDoc(docRef, {
            ...ticket,
            updated_at: new Date().toISOString()
          }, { merge: true });
        })
      );
    } catch (err) {
      console.warn('Firestore saveTickets error:', err);
    }
  },

  /**
   * Real-time entrance ticket validation on the central Firestore database
   */
  async validateTicket(
    identifier: string,
    operator: string,
    method: 'camera' | 'manual' = 'camera'
  ): Promise<ValidationResult | null> {
    try {
      const raw = identifier.trim();
      let searchKey = raw.toUpperCase();

      // Check if JSON QR code was scanned
      try {
        const parsed = JSON.parse(raw);
        if (parsed.t) searchKey = String(parsed.t).trim().toUpperCase();
        else if (parsed.qr_token) searchKey = String(parsed.qr_token).trim().toUpperCase();
      } catch {}

      // 1. Direct lookup by ticket_number (Primary Key)
      let ticketDoc = await getDoc(doc(db, 'tickets', searchKey));
      let ticketData: Ticket | null = ticketDoc.exists() ? (ticketDoc.data() as Ticket) : null;

      // 2. Secondary query by qr_token or phone if not found by ticket number
      if (!ticketData) {
        const qToken = query(collection(db, 'tickets'), where('qr_token', '==', raw), limit(1));
        const snapToken = await getDocs(qToken);
        if (!snapToken.empty) {
          ticketDoc = snapToken.docs[0];
          ticketData = ticketDoc.data() as Ticket;
        }
      }

      if (!ticketData) {
        // Fallback query for clean ticket numbers
        const qNumber = query(collection(db, 'tickets'), where('ticket_number', '==', searchKey), limit(1));
        const snapNumber = await getDocs(qNumber);
        if (!snapNumber.empty) {
          ticketDoc = snapNumber.docs[0];
          ticketData = ticketDoc.data() as Ticket;
        }
      }

      if (!ticketData) {
        return null; // Let the local/backend pipeline handle or report invalid
      }

      const now = new Date().toISOString();

      // Status check
      if (ticketData.status === 'CANCELLED') {
        return {
          valid: false,
          status: 'CANCELLED',
          message: 'BILLET ANNULÉ : Cette commande a été annulée ou remboursée.',
          ticket: ticketData
        };
      }

      if (ticketData.status === 'USED') {
        return {
          valid: false,
          status: 'ALREADY_USED',
          message: 'BILLET DÉJÀ UTILISÉ !',
          ticket: ticketData,
          used_at: ticketData.used_at || now,
          validated_by: ticketData.validated_by || 'Agent Sécurité'
        };
      }

      // Atomic update in Firestore
      const updatedTicket: Ticket = {
        ...ticketData,
        status: 'USED',
        used_at: now,
        validated_by: operator
      };

      await updateDoc(doc(db, 'tickets', ticketData.ticket_number), {
        status: 'USED',
        used_at: now,
        validated_by: operator
      });

      // Write check-in audit record to Firestore
      const checkInRecord: CheckIn = {
        id: `chk-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        ticket_id: ticketData.id,
        ticket_number: ticketData.ticket_number,
        qr_token: ticketData.qr_token,
        customer_name: ticketData.customer_name,
        ticket_type: ticketData.ticket_type,
        scanned_at: now,
        operator,
        method
      };

      await setDoc(doc(db, 'check_ins', checkInRecord.id), checkInRecord);

      return {
        valid: true,
        status: 'VALID',
        message: 'BILLET VALIDE : Entrée autorisée ! Bienvenue au Jersey Night Club Party Remix 2026 !',
        ticket: updatedTicket,
        used_at: now,
        validated_by: operator
      };
    } catch (err) {
      console.warn('Firestore validateTicket error:', err);
      return null;
    }
  },

  /**
   * Subscribe to live Orders across all devices
   */
  subscribeOrders(onUpdate: (orders: Order[]) => void): Unsubscribe {
    const q = query(collection(db, 'orders'));
    return onSnapshot(q, (snapshot) => {
      const orders: Order[] = [];
      snapshot.forEach(docSnap => {
        orders.push(docSnap.data() as Order);
      });
      // Sort newest first
      orders.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      onUpdate(orders);
    }, (err) => {
      console.warn('Firestore orders subscription error:', err);
    });
  },

  /**
   * Subscribe to live Check-Ins across all scanners
   */
  subscribeCheckIns(onUpdate: (checkIns: CheckIn[]) => void): Unsubscribe {
    const q = query(collection(db, 'check_ins'));
    return onSnapshot(q, (snapshot) => {
      const checkIns: CheckIn[] = [];
      snapshot.forEach(docSnap => {
        checkIns.push(docSnap.data() as CheckIn);
      });
      checkIns.sort((a, b) => new Date(b.scanned_at).getTime() - new Date(a.scanned_at).getTime());
      onUpdate(checkIns);
    }, (err) => {
      console.warn('Firestore check-ins subscription error:', err);
    });
  },

  /**
   * Subscribe to all live Tickets in real-time
   */
  subscribeTickets(onUpdate: (tickets: Ticket[]) => void): Unsubscribe {
    const q = query(collection(db, 'tickets'));
    return onSnapshot(q, (snapshot) => {
      const tickets: Ticket[] = [];
      snapshot.forEach(docSnap => {
        tickets.push(docSnap.data() as Ticket);
      });
      tickets.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      onUpdate(tickets);
    }, (err) => {
      console.warn('Firestore tickets subscription error:', err);
    });
  },

  /**
   * Subscribe to all Promo Codes in real-time
   */
  subscribePromoCodes(onUpdate: (promos: PromoCode[]) => void): Unsubscribe {
    const q = query(collection(db, 'promo_codes'));
    return onSnapshot(q, (snapshot) => {
      const promos: PromoCode[] = [];
      snapshot.forEach(docSnap => {
        promos.push(docSnap.data() as PromoCode);
      });
      onUpdate(promos);
    }, (err) => {
      console.warn('Firestore promo_codes subscription error:', err);
    });
  },

  /**
   * Save Promo Code
   */
  async savePromoCode(promo: PromoCode): Promise<void> {
    try {
      await setDoc(doc(db, 'promo_codes', promo.id), promo, { merge: true });
    } catch (err) {
      console.warn('Firestore savePromoCode error:', err);
    }
  },

  /**
   * Delete Promo Code
   */
  async deletePromoCode(id: string): Promise<void> {
    try {
      await deleteDoc(doc(db, 'promo_codes', id));
    } catch (err) {
      console.warn('Firestore deletePromoCode error:', err);
    }
  },

  /**
   * Reset sales data across Firestore collections
   */
  async resetSalesData(options?: {
    resetOrders?: boolean;
    resetTickets?: boolean;
    resetCheckIns?: boolean;
  }): Promise<void> {
    try {
      if (options?.resetOrders !== false) {
        const orderSnap = await getDocs(collection(db, 'orders'));
        const deletes = orderSnap.docs.map(d => deleteDoc(d.ref));
        await Promise.all(deletes);
      }

      if (options?.resetTickets !== false) {
        const ticketSnap = await getDocs(collection(db, 'tickets'));
        const deletes = ticketSnap.docs.map(d => deleteDoc(d.ref));
        await Promise.all(deletes);
      }

      if (options?.resetCheckIns !== false) {
        const checkInSnap = await getDocs(collection(db, 'check_ins'));
        const deletes = checkInSnap.docs.map(d => deleteDoc(d.ref));
        await Promise.all(deletes);
      }

      // Reset sold_quantity on ticket_types to 0
      const ttSnap = await getDocs(collection(db, 'ticket_types'));
      const updates = ttSnap.docs.map(d => updateDoc(d.ref, { sold_quantity: 0 }));
      await Promise.all(updates);
    } catch (err) {
      console.warn('Firestore resetSalesData error:', err);
    }
  },

  /**
   * Save or update Event details in central Firestore
   */
  async saveEvent(event: Partial<EventItem>): Promise<void> {
    try {
      const eventId = event.id || 'event-jersey-2026';
      await setDoc(doc(db, 'events', eventId), {
        ...event,
        updated_at: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      console.warn('Firestore saveEvent error:', err);
    }
  },

  /**
   * Subscribe to live Event details in real-time
   */
  subscribeEvent(eventId: string, onUpdate: (event: EventItem) => void): Unsubscribe {
    const targetId = eventId || 'event-jersey-2026';
    return onSnapshot(doc(db, 'events', targetId), (snapshot) => {
      if (snapshot.exists()) {
        onUpdate(snapshot.data() as EventItem);
      }
    }, (err) => {
      console.warn('Firestore event subscription error:', err);
    });
  },

  /**
   * Save or update Ticket Types in central Firestore
   */
  async saveTicketType(type: TicketType): Promise<void> {
    try {
      await setDoc(doc(db, 'ticket_types', type.id), {
        ...type,
        updated_at: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      console.warn('Firestore saveTicketType error:', err);
    }
  },

  /**
   * Subscribe to live Ticket Types in real-time
   */
  subscribeTicketTypes(onUpdate: (types: TicketType[]) => void): Unsubscribe {
    const q = query(collection(db, 'ticket_types'));
    return onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const types: TicketType[] = [];
        snapshot.forEach(docSnap => {
          types.push(docSnap.data() as TicketType);
        });
        onUpdate(types);
      }
    }, (err) => {
      console.warn('Firestore ticket_types subscription error:', err);
    });
  },

  /**
   * Save or update Program item in central Firestore
   */
  async saveProgramItem(item: ProgramItem): Promise<void> {
    try {
      await setDoc(doc(db, 'programs', item.id), {
        ...item,
        updated_at: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      console.warn('Firestore saveProgramItem error:', err);
    }
  },

  /**
   * Delete Program item in central Firestore
   */
  async deleteProgramItem(id: string): Promise<void> {
    try {
      await deleteDoc(doc(db, 'programs', id));
    } catch (err) {
      console.warn('Firestore deleteProgramItem error:', err);
    }
  },

  /**
   * Subscribe to live Program items in real-time
   */
  subscribePrograms(onUpdate: (programs: ProgramItem[]) => void): Unsubscribe {
    const q = query(collection(db, 'programs'));
    return onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const programs: ProgramItem[] = [];
        snapshot.forEach(docSnap => {
          programs.push(docSnap.data() as ProgramItem);
        });
        programs.sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
        onUpdate(programs);
      }
    }, (err) => {
      console.warn('Firestore programs subscription error:', err);
    });
  },

  /**
   * Save global App Settings in central Firestore
   */
  async saveSettings(settings: Partial<AppSettings>): Promise<void> {
    try {
      await setDoc(doc(db, 'settings', 'app_settings'), {
        ...settings,
        updated_at: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      console.warn('Firestore saveSettings error:', err);
    }
  },

  /**
   * Subscribe to live App Settings in real-time
   */
  subscribeSettings(onUpdate: (settings: AppSettings) => void): Unsubscribe {
    return onSnapshot(doc(db, 'settings', 'app_settings'), (snapshot) => {
      if (snapshot.exists()) {
        onUpdate(snapshot.data() as AppSettings);
      }
    }, (err) => {
      console.warn('Firestore settings subscription error:', err);
    });
  },

  /**
   * Seed initial data into Firestore if it hasn't been initialized yet
   */
  async seedInitialDataIfEmpty(
    defaultEvent: EventItem,
    defaultTicketTypes: TicketType[],
    defaultPrograms: ProgramItem[],
    defaultSettings: AppSettings
  ): Promise<void> {
    try {
      const eventDoc = await getDoc(doc(db, 'events', defaultEvent.id));
      if (!eventDoc.exists()) {
        await setDoc(doc(db, 'events', defaultEvent.id), defaultEvent);
        for (const tt of defaultTicketTypes) {
          await setDoc(doc(db, 'ticket_types', tt.id), tt);
        }
        for (const prog of defaultPrograms) {
          await setDoc(doc(db, 'programs', prog.id), prog);
        }
        await setDoc(doc(db, 'settings', 'app_settings'), defaultSettings);
      }
    } catch (err) {
      console.warn('Firestore initial seeding note:', err);
    }
  }
};
