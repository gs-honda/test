// ══════════════════════════════════════════════════════════════
// 発注管理システム - 共通設定・Supabase接続モジュール
// config.js
//
// 各画面のHTMLから <script src="config.js"></script> で読み込む
// Supabase JS Client は CDN から読み込む前提
// ══════════════════════════════════════════════════════════════

// ┌──────────────────────────────────────────┐
// │  ★ この2つを自分のSupabaseプロジェクトに合わせて変更 │
// └──────────────────────────────────────────┘
const SUPABASE_URL = 'https://nrllslznurnaqrnwnudh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5ybGxzbHpudXJuYXFybndudWRoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5MjIwOTcsImV4cCI6MjA5MDQ5ODA5N30.TkLDPhOowU2be2F7L_8FY3adSQiD2hIR37bh9KDNhNY';

// ── Supabase Client 初期化 ──
// CDNが window.supabase にライブラリを公開するため、変数名を db にする
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ══════════════════════════════════════════════════════════════
// 認証（アクセスコード方式）
// ══════════════════════════════════════════════════════════════

async function loginWithCode(code) {
  const { data, error } = await db
    .from('brand_access_codes')
    .select('code, role, brand_code, label, email')
    .eq('code', code.toUpperCase())
    .single();

  if (error || !data) return null;
  return data;
}

// ══════════════════════════════════════════════════════════════
// 発注 (orders)
// ══════════════════════════════════════════════════════════════

// 発注一覧を取得（ブランドフィルタ付き）
async function fetchOrders(brandCode) {
  let query = supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });

  if (brandCode) {
    query = query.eq('brand_code', brandCode);
  }

  const { data, error } = await query;
  if (error) { console.error('fetchOrders error:', error); return []; }
  return data;
}

// 発注＋納品予定を結合取得
async function fetchOrdersWithDeliveries(brandCode) {
  let query = supabase
    .from('orders')
    .select(`
      *,
      delivery_schedules (
        id, scheduled_date, quantity, status,
        actual_delivery_date, inspection_date, sort_order,
        created_at, updated_at
      )
    `)
    .order('created_at', { ascending: false });

  if (brandCode) {
    query = query.eq('brand_code', brandCode);
  }

  const { data, error } = await query;
  if (error) { console.error('fetchOrdersWithDeliveries error:', error); return []; }

  // delivery_schedulesをsort_orderで並べ替え
  if (data) {
    data.forEach(order => {
      if (order.delivery_schedules) {
        order.delivery_schedules.sort((a, b) => a.sort_order - b.sort_order);
      }
    });
  }

  return data || [];
}

// 新規発注を作成
async function createOrder({ sku, product_name, unit_price, quantity, brand_code, desired_date, note }) {
  const { data, error } = await db
    .from('orders')
    .insert({
      sku,
      product_name,
      unit_price: unit_price || null,
      quantity,
      brand_code,
      desired_date,
      note: note || '',
    })
    .select()
    .single();

  if (error) { console.error('createOrder error:', error); return null; }
  return data;
}

// 発注を取消
async function cancelOrder(orderId, reason, accessCode) {
  const { error: updateError } = await db
    .from('orders')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancel_reason: reason || '',
    })
    .eq('id', orderId);

  if (updateError) { console.error('cancelOrder error:', updateError); return false; }

  // 変更ログに取消を記録（トリガーはdelivery_schedules用なので、取消はアプリ側で記録）
  await db.from('delivery_change_logs').insert({
    order_id: orderId,
    change_type: 'order_cancelled',
    field_name: '発注取消',
    new_value: reason || '',
    changed_by_code: accessCode,
    changed_by_role: 'admin',
  });

  return true;
}

// ══════════════════════════════════════════════════════════════
// 納品予定 (delivery_schedules)
// ══════════════════════════════════════════════════════════════

// メーカーが納品予定を初回回答（複数行=分納対応）
async function submitDeliverySchedules(orderId, schedules, accessCode) {
  const rows = schedules.map((s, i) => ({
    order_id: orderId,
    scheduled_date: s.scheduledDate,
    quantity: s.quantity,
    sort_order: i + 1,
  }));

  const { data, error } = await db
    .from('delivery_schedules')
    .insert(rows)
    .select();

  if (error) { console.error('submitDeliverySchedules error:', error); return null; }

  // changed_by情報をログに追記（トリガーが作ったログのchanged_byを更新）
  if (data) {
    for (const ds of data) {
      await db
        .from('delivery_change_logs')
        .update({ changed_by_code: accessCode, changed_by_role: 'manufacturer' })
        .eq('delivery_schedule_id', ds.id)
        .eq('change_type', 'delivery_created');
    }
  }

  return data;
}

// メーカーが納品予定を更新（既存行の日付・数量変更）
async function updateDeliverySchedule(deliveryId, scheduledDate, quantity, accessCode) {
  const { error } = await db
    .from('delivery_schedules')
    .update({ scheduled_date: scheduledDate, quantity })
    .eq('id', deliveryId);

  if (error) { console.error('updateDeliverySchedule error:', error); return false; }

  // changed_by情報をログに追記
  await db
    .from('delivery_change_logs')
    .update({ changed_by_code: accessCode, changed_by_role: 'manufacturer' })
    .eq('delivery_schedule_id', deliveryId)
    .is('changed_by_code', null)
    .in('change_type', ['delivery_date_changed', 'delivery_qty_changed']);

  return true;
}

// メーカーが分納を追加
async function addDeliverySchedule(orderId, scheduledDate, quantity, sortOrder, accessCode) {
  const { data, error } = await db
    .from('delivery_schedules')
    .insert({
      order_id: orderId,
      scheduled_date: scheduledDate,
      quantity,
      sort_order: sortOrder,
    })
    .select()
    .single();

  if (error) { console.error('addDeliverySchedule error:', error); return null; }

  // changed_by更新
  if (data) {
    await db
      .from('delivery_change_logs')
      .update({ changed_by_code: accessCode, changed_by_role: 'manufacturer' })
      .eq('delivery_schedule_id', data.id)
      .eq('change_type', 'delivery_created');
  }

  return data;
}

// 分納を削除
async function removeDeliverySchedule(deliveryId) {
  const { error } = await db
    .from('delivery_schedules')
    .delete()
    .eq('id', deliveryId);

  if (error) { console.error('removeDeliverySchedule error:', error); return false; }
  return true;
}

// 倉庫が納品日を記録
async function recordDelivery(deliveryId, actualDate, accessCode) {
  const { error } = await db
    .from('delivery_schedules')
    .update({
      status: 'delivered',
      actual_delivery_date: actualDate,
    })
    .eq('id', deliveryId);

  if (error) { console.error('recordDelivery error:', error); return false; }

  // changed_by更新
  await db
    .from('delivery_change_logs')
    .update({ changed_by_code: accessCode, changed_by_role: 'warehouse' })
    .eq('delivery_schedule_id', deliveryId)
    .eq('change_type', 'delivery_recorded')
    .is('changed_by_code', null);

  return true;
}

// 倉庫が検品完了を記録
async function recordInspection(deliveryId, inspectionDate, accessCode) {
  const { error } = await db
    .from('delivery_schedules')
    .update({
      status: 'inspected',
      inspection_date: inspectionDate,
    })
    .eq('id', deliveryId);

  if (error) { console.error('recordInspection error:', error); return false; }

  // changed_by更新
  await db
    .from('delivery_change_logs')
    .update({ changed_by_code: accessCode, changed_by_role: 'warehouse' })
    .eq('delivery_schedule_id', deliveryId)
    .eq('change_type', 'inspection_recorded')
    .is('changed_by_code', null);

  return true;
}

// ══════════════════════════════════════════════════════════════
// 倉庫ビュー
// ══════════════════════════════════════════════════════════════

async function fetchWarehouseDeliveries() {
  const { data, error } = await db
    .from('warehouse_delivery_view')
    .select('*')
    .order('scheduled_date', { ascending: true });

  if (error) { console.error('fetchWarehouseDeliveries error:', error); return []; }
  return data || [];
}

// ══════════════════════════════════════════════════════════════
// 変更ログ
// ══════════════════════════════════════════════════════════════

async function fetchChangeLogs(brandCode) {
  let query = supabase
    .from('order_change_log_view')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  if (brandCode) {
    query = query.eq('brand_code', brandCode);
  }

  const { data, error } = await query;
  if (error) { console.error('fetchChangeLogs error:', error); return []; }
  return data || [];
}

// 未通知の変更ログを取得（倉庫画面の通知バナー用）
async function fetchUnnotifiedChanges() {
  const { data, error } = await db
    .from('delivery_change_logs')
    .select(`
      *,
      orders!inner ( sku, product_name, brand_code )
    `)
    .eq('notified', false)
    .in('change_type', ['delivery_date_changed', 'delivery_qty_changed', 'delivery_added', 'delivery_removed'])
    .order('created_at', { ascending: false });

  if (error) { console.error('fetchUnnotifiedChanges error:', error); return []; }
  return data || [];
}

// 変更を通知済みにする
async function markNotified(logIds) {
  const { error } = await db
    .from('delivery_change_logs')
    .update({ notified: true })
    .in('id', logIds);

  if (error) { console.error('markNotified error:', error); return false; }
  return true;
}

// ══════════════════════════════════════════════════════════════
// Realtime（画面のリアルタイム更新用）
// ══════════════════════════════════════════════════════════════

function subscribeToDeliveryChanges(callback) {
  return db
    .channel('delivery_changes')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'delivery_schedules',
    }, callback)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'orders',
    }, callback)
    .subscribe();
}

function subscribeToChangeLog(callback) {
  return db
    .channel('change_log')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'delivery_change_logs',
    }, callback)
    .subscribe();
}

// ══════════════════════════════════════════════════════════════
// ユーティリティ
// ══════════════════════════════════════════════════════════════

function formatDateDisplay(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-');
  return `${y}/${m}/${d}`;
}

function todayStr() {
  const t = new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
