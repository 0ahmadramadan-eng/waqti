/* =============================================
   Waqti — app.js  (Multi-Session)
   ============================================= */

// ===== DATA =====
const DB = {
  getUsers:        ()    => JSON.parse(localStorage.getItem('wt_users') || '{}'),
  saveUsers:       (u)   => localStorage.setItem('wt_users', JSON.stringify(u)),
  getCurrentUser:  ()    => localStorage.getItem('wt_current_user'),
  setCurrentUser:  (u)   => localStorage.setItem('wt_current_user', u),
  clearCurrentUser:()    => localStorage.removeItem('wt_current_user'),
  getUserData:     (u)   => JSON.parse(localStorage.getItem(`wt_data_${u}`) || 'null'),
  saveUserData:    (u,d) => localStorage.setItem(`wt_data_${u}`, JSON.stringify(d)),
  defaultData:     (name) => ({
    name,
    settings: { salaryType:'hourly', hourlyRate:5, dailyRate:50, workStart:'08:00', workEnd:'17:00' },
    // attendance: { 'YYYY-MM-DD': { sessions:[{in,out},...] } }
    attendance:   {},
    transactions: [],
    notes:        {},
    absences:     {}
  })
};

// ===== HELPERS: Sessions =====
// يرجع الجلسة المفتوحة الحالية (in بدون out) أو null
function getOpenSession(dateStr) {
  const day = userData.attendance[dateStr];
  if (!day?.sessions) return null;
  return day.sessions.find(s => s.in && !s.out) || null;
}

// يرجع مجموع الساعات لكل جلسات اليوم
function getTotalHours(dateStr) {
  const day = userData.attendance[dateStr];
  if (!day?.sessions?.length) return 0;
  const now = getCurrentTimeStr();
  return day.sessions.reduce((total, s) => {
    if (!s.in) return total;
    const end = s.out || now; // الجلسة المفتوحة تحسب لحد الآن
    return total + calcHours(s.in, end);
  }, 0);
}

// يرجع أول وقت حضور اليوم
function getFirstIn(dateStr) {
  const day = userData.attendance[dateStr];
  return day?.sessions?.[0]?.in || null;
}

// يرجع آخر وقت انصراف
function getLastOut(dateStr) {
  const day = userData.attendance[dateStr];
  if (!day?.sessions?.length) return null;
  const outs = day.sessions.filter(s => s.out).map(s => s.out);
  return outs.length ? outs[outs.length - 1] : null;
}

// migrate البيانات القديمة { in, out } للنظام الجديد
function migrateAttendance() {
  let changed = false;
  Object.keys(userData.attendance).forEach(dateStr => {
    const day = userData.attendance[dateStr];
    if (day && !day.sessions) {
      userData.attendance[dateStr] = {
        sessions: [{ in: day.in || null, out: day.out || null }]
      };
      changed = true;
    }
  });
  if (changed) saveData();
}

// ===== STATE =====
let currentUser     = null;
let userData        = null;
let currentTxType   = null;
let reportDate      = new Date();
let permDeduct      = false;
let calcedRate      = 0;
let liveTimer       = null;
let countdownTimer  = null;
let deferredInstall = null;
let currentAbsenceType = null;

// ===== PWA =====
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  const card = document.getElementById('install-card');
  if (card) card.style.display = 'block';
});

async function installPWA() {
  if (!deferredInstall) { showToast('📲 افتح المتصفح واضغط "إضافة للشاشة الرئيسية"'); return; }
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  if (outcome === 'accepted') {
    showToast('✅ تم تثبيت Waqti بنجاح!');
    document.getElementById('install-card').style.display = 'none';
    deferredInstall = null;
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  const saved = DB.getCurrentUser();
  if (saved && DB.getUsers()[saved]) { loginUser(saved); return; }
  showScreen('auth');
});

// ===== NAVIGATION =====
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`)?.classList.add('active');
}

function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  document.getElementById(`nav-${page}`)?.classList.add('active');
  if (page === 'home')    refreshHome();
  if (page === 'reports') {
    refreshReports();
    const ms = `${reportDate.getFullYear()}-${String(reportDate.getMonth()+1).padStart(2,'0')}`;
    setTimeout(() => { renderChart(ms); renderCalendar(ms); }, 50);
  }
  if (page === 'settings') loadSettings();
}

// ===== AUTH =====
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');
}

function handleRegister() {
  const name     = document.getElementById('reg-name').value.trim();
  const username = document.getElementById('reg-username').value.trim().toLowerCase();
  const password = document.getElementById('reg-password').value;
  const errEl    = document.getElementById('reg-error');
  if (!name || !username || !password) { showError(errEl, 'يرجى ملء جميع الحقول'); return; }
  if (username.length < 3) { showError(errEl, 'اسم المستخدم لا يقل عن 3 أحرف'); return; }
  if (password.length < 4) { showError(errEl, 'كلمة السر لا تقل عن 4 أحرف'); return; }
  const users = DB.getUsers();
  if (users[username]) { showError(errEl, 'اسم المستخدم موجود مسبقاً'); return; }
  users[username] = { password: btoa(password) };
  DB.saveUsers(users);
  DB.saveUserData(username, DB.defaultData(name));
  errEl.classList.add('hidden');
  loginUser(username);
}

function handleLogin() {
  const username = document.getElementById('login-username').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  if (!username || !password) { showError(errEl, 'يرجى ملء جميع الحقول'); return; }
  const users = DB.getUsers();
  if (!users[username] || users[username].password !== btoa(password)) {
    showError(errEl, 'اسم المستخدم أو كلمة السر غير صحيحة'); return;
  }
  errEl.classList.add('hidden');
  loginUser(username);
}

function loginUser(username) {
  currentUser = username;
  userData    = DB.getUserData(username) || DB.defaultData(username);
  DB.saveUserData(username, userData);
  DB.setCurrentUser(username);
  migrateAttendance(); // تحويل البيانات القديمة إن وجدت
  const initial = (userData.name || username).charAt(0).toUpperCase();
  document.getElementById('user-avatar').textContent       = initial;
  document.getElementById('user-name-display').textContent = userData.name || username;
  document.getElementById('topbar-date').textContent       = formatDateShort2(new Date());
  initTheme();
  showScreen('app');
  navigateTo('home');
}

function handleLogout() {
  stopLiveTimer();
  DB.clearCurrentUser();
  currentUser = userData = null;
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
  showScreen('auth');
}

// ===== CONFIRM =====
function showConfirm(icon, title, msg, onYes) {
  document.getElementById('confirm-icon').textContent  = icon;
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-msg').textContent   = msg;
  document.getElementById('confirm-yes-btn').onclick   = () => { closeConfirm(); onYes(); };
  document.getElementById('modal-confirm').classList.remove('hidden');
}
function closeConfirm() {
  document.getElementById('modal-confirm').classList.add('hidden');
}

// ===== LIVE TIMER =====
function startLiveTimer() {
  stopLiveTimer();
  liveTimer = setInterval(() => {
    const today = getTodayStr();
    if (getOpenSession(today)) {
      const hrs = getTotalHours(today);
      document.getElementById('work-time-live').textContent = formatLiveTime(hrs);
      refreshSummary(today);
    } else {
      stopLiveTimer();
    }
  }, 30000);
}

function stopLiveTimer() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  const el = document.getElementById('work-time-live');
  if (el) el.textContent = '';
  stopCountdown();
}

function formatLiveTime(hrs) {
  const h = Math.floor(hrs);
  const m = Math.round((hrs - h) * 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} ⏱`;
}

// ===== HOME =====
function refreshHome() {
  const today      = getTodayStr();
  const openSess   = getOpenSession(today);
  const day        = userData.attendance[today];
  const hasSessions = day?.sessions?.length > 0;

  const btn      = document.getElementById('checkin-btn');
  const icon     = document.getElementById('checkin-icon');
  const label    = document.getElementById('checkin-label');
  const timeEl   = document.getElementById('checkin-time');
  const badge    = document.getElementById('status-badge');
  const pulse    = document.getElementById('pulse-ring');
  const permWrap = document.getElementById('permission-btn-wrap');
  const liveEl   = document.getElementById('work-time-live');

  btn.className = 'checkin-btn';
  pulse.classList.remove('active');
  badge.className = 'status-badge';
  permWrap.classList.add('hidden');
  liveEl.textContent = '';
  stopLiveTimer();

  if (!hasSessions) {
    // لم يُسجَّل حضور بعد
    icon.textContent   = '👆';
    label.textContent  = 'تسجيل حضور';
    timeEl.textContent = 'اضغط للتسجيل';
    badge.textContent  = 'غير مسجل';
  } else if (openSess) {
    // جلسة مفتوحة — حاضر
    btn.classList.add('checked-in');
    pulse.classList.add('active');
    icon.textContent   = '🚪';
    label.textContent  = 'تسجيل انصراف';
    timeEl.textContent = 'حضور: ' + openSess.in;
    badge.textContent  = '🟢 حاضر منذ ' + openSess.in;
    badge.classList.add('in');
    permWrap.classList.remove('hidden');
    const hrs = getTotalHours(today);
    liveEl.textContent = formatLiveTime(hrs);
    startLiveTimer();
    startCountdown();
  } else {
    // كل الجلسات مغلقة — انصرف
    const sessCount = day.sessions.length;
    btn.classList.add('checked-in'); // يسمح بجلسة جديدة
    icon.textContent   = '👆';
    label.textContent  = 'بصمة جديدة';
    const lastOut = getLastOut(today);
    timeEl.textContent = `${sessCount} جلسة | آخر خروج: ${lastOut}`;
    badge.textContent  = `✔ ${sessCount} جلسة اليوم`;
    badge.classList.add('in');
  }

  refreshSummary(today);
  renderTodayTransactions(today);
  loadDailyNote(today);
  refreshAbsenceButtons(today);
}

// ===== TOGGLE ATTENDANCE (Multi-Session) =====
function toggleAttendance() {
  const today    = getTodayStr();
  const openSess = getOpenSession(today);

  if (!openSess) {
    // تسجيل حضور — جلسة جديدة
    showConfirm('👆', 'تسجيل الحضور', 'هل تريد تسجيل حضورك الآن؟', () => {
      if (!userData.attendance[today]) userData.attendance[today] = { sessions: [] };
      if (!userData.attendance[today].sessions) userData.attendance[today].sessions = [];
      userData.attendance[today].sessions.push({ in: getCurrentTimeStr(), out: null });
      saveData(); refreshHome();
      showToast('✅ تم تسجيل الحضور ' + getCurrentTimeStr());
    });
  } else {
    // تسجيل انصراف — أغلق الجلسة المفتوحة
    showConfirm('🚪', 'تسجيل الانصراف', 'هل تريد تسجيل انصرافك الآن؟', () => {
      openSess.out = getCurrentTimeStr();
      saveData(); refreshHome();
      showToast('👋 تم تسجيل الانصراف ' + openSess.out);
    });
  }
}

// ===== PERMISSION =====
function openPermissionModal() {
  document.getElementById('perm-reason').value = '';
  document.getElementById('perm-error').classList.add('hidden');
  setDeduct(false);
  document.getElementById('modal-permission').classList.remove('hidden');
}
function closePermissionModal() { document.getElementById('modal-permission').classList.add('hidden'); }
function closePermModal(e) { if (e.target.classList.contains('modal-overlay')) closePermissionModal(); }

function setDeduct(val) {
  permDeduct = val;
  document.getElementById('deduct-yes').className = 'perm-deduct-btn' + (val ? ' active-yes' : '');
  document.getElementById('deduct-no').className  = 'perm-deduct-btn' + (!val ? ' active-no' : '');
}

function savePermission() {
  const reason = document.getElementById('perm-reason').value.trim();
  const errEl  = document.getElementById('perm-error');
  if (!reason) { showError(errEl, 'أدخل سبب الخروج'); return; }
  const today = getTodayStr();
  if (!getOpenSession(today)) { showError(errEl, 'لم يُسجَّل الحضور بعد'); return; }
  userData.transactions.push({
    id: Date.now(), date: today, time: getCurrentTimeStr(),
    type: 'permission',
    desc: (permDeduct ? 'إذن خروج (يُخصم): ' : 'إذن خروج: ') + reason,
    amount: 0, deduct: permDeduct
  });
  saveData(); closePermissionModal(); refreshHome();
  showToast(permDeduct ? '🚶 إذن مسجل — سيُخصم الوقت' : '🚶 إذن مسجل بدون خصم');
}

// ===== TRANSACTIONS =====
function openTransactionModal(type) {
  currentTxType = type;
  document.getElementById('modal-title').textContent = type === 'withdrawal' ? '💵 مسحوب نقدي' : '📦 بضاعة مأخوذة';
  document.getElementById('tx-desc').value   = '';
  document.getElementById('tx-amount').value = '';
  document.getElementById('tx-error').classList.add('hidden');
  document.getElementById('modal-transaction').classList.remove('hidden');
}
function closeTransactionModal() { document.getElementById('modal-transaction').classList.add('hidden'); }
function closeModal(e) { if (e.target.classList.contains('modal-overlay')) closeTransactionModal(); }

function saveTransaction() {
  const desc   = document.getElementById('tx-desc').value.trim();
  const amount = parseFloat(document.getElementById('tx-amount').value);
  const errEl  = document.getElementById('tx-error');
  if (!desc)               { showError(errEl, 'أدخل وصف المعاملة'); return; }
  if (!amount || amount<=0){ showError(errEl, 'أدخل مبلغ صحيح'); return; }
  userData.transactions.push({
    id: Date.now(), date: getTodayStr(), time: getCurrentTimeStr(),
    type: currentTxType, desc, amount
  });
  saveData(); closeTransactionModal(); refreshHome();
  showToast(currentTxType === 'withdrawal' ? '💵 تم تسجيل المسحوب' : '📦 تم تسجيل البضاعة');
}

// ===== SUMMARY =====
function refreshSummary(dateStr) {
  const s     = userData.settings;
  const hours = getTotalHours(dateStr);
  const earned = hours > 0
    ? (s.salaryType === 'hourly' ? hours * (s.hourlyRate||0) : (s.dailyRate||0))
    : 0;
  const txs  = userData.transactions.filter(t => t.date === dateStr && t.amount > 0);
  const deds = txs.reduce((sum,t) => sum + t.amount, 0);
  document.getElementById('sum-hours').textContent      = hours.toFixed(1) + ' س';
  document.getElementById('sum-earned').textContent     = earned.toFixed(1) + ' د';
  document.getElementById('sum-deductions').textContent = deds.toFixed(1) + ' د';
  document.getElementById('sum-net').textContent        = (earned - deds).toFixed(1) + ' د';
}

function renderTodayTransactions(dateStr) {
  const list = document.getElementById('today-transactions');
  const day  = userData.attendance[dateStr];
  const sessions = day?.sessions || [];

  // عرض الجلسات
  let sessHtml = '';
  if (sessions.length > 0) {
    sessHtml = sessions.map((s, i) => `
      <div class="tx-item permission">
        <div class="tx-info">
          <div class="tx-desc">⏱ جلسة ${i+1}</div>
          <div class="tx-meta">${s.in} — ${s.out || 'مفتوحة'}</div>
        </div>
        <div class="tx-amount" style="color:var(--accent)">${calcHours(s.in, s.out||getCurrentTimeStr()).toFixed(1)} س</div>
      </div>`).join('');
  }

  const txs = userData.transactions.filter(t => t.date === dateStr).reverse();
  const txHtml = txs.map(t => {
    const icon = t.type==='withdrawal'?'💵':t.type==='purchase'?'📦':'🚶';
    const amt  = t.amount > 0 ? `- ${t.amount.toFixed(1)} د` : '—';
    return `<div class="tx-item ${t.type}">
      <div class="tx-info">
        <div class="tx-desc">${icon} ${t.desc}</div>
        <div class="tx-meta">${formatTimeStr(t.time)}</div>
      </div>
      <div class="tx-amount">${amt}</div>
    </div>`;
  }).join('');

  list.innerHTML = sessHtml + txHtml || '<div class="empty-state">لا توجد معاملات اليوم</div>';
}

// ===== REPORTS =====
function changeMonth(dir) {
  reportDate.setMonth(reportDate.getMonth()+dir);
  refreshReports();
  const ms = `${reportDate.getFullYear()}-${String(reportDate.getMonth()+1).padStart(2,'0')}`;
  setTimeout(() => { renderChart(ms); renderCalendar(ms); }, 50);
}

function refreshReports() {
  const y = reportDate.getFullYear(), m = reportDate.getMonth();
  const ms = `${y}-${String(m+1).padStart(2,'0')}`;
  const MN = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  document.getElementById('report-month-label').textContent = `${MN[m]} ${y}`;
  const s = userData.settings;
  let totalE=0, totalD=0, days=0;
  const rows = [];

  Object.keys(userData.attendance).filter(d=>d.startsWith(ms)).sort().forEach(dateStr => {
    const hours = getTotalHours(dateStr);
    if (hours <= 0) return;
    const earned = s.salaryType==='hourly' ? hours*(s.hourlyRate||0) : (s.dailyRate||0);
    const dayTx  = userData.transactions.filter(t=>t.date===dateStr&&t.amount>0);
    const dayDed = dayTx.reduce((sum,t)=>sum+t.amount, 0);
    const day    = userData.attendance[dateStr];
    const firstIn  = getFirstIn(dateStr);
    const lastOut  = getLastOut(dateStr);
    const sessCount = day?.sessions?.length || 0;
    totalE+=earned; totalD+=dayDed; days++;
    rows.push({dateStr, hours, earned, dayDed, firstIn, lastOut, sessCount});
  });

  document.getElementById('rep-salary').textContent     = totalE.toFixed(1)+' د';
  document.getElementById('rep-deductions').textContent = totalD.toFixed(1)+' د';
  document.getElementById('rep-net').textContent        = (totalE-totalD).toFixed(1)+' د';
  document.getElementById('rep-days').textContent       = days+' يوم';

  const dl = document.getElementById('report-days-list');
  dl.innerHTML = rows.length ? [...rows].reverse().map(r=>`
    <div class="report-day-item">
      <div class="rdi-left">
        <div class="rdi-date">${formatDateShort(r.dateStr)}</div>
        <div class="rdi-hours">⏱ ${r.hours.toFixed(1)}س | ${r.firstIn||'—'} — ${r.lastOut||'مفتوح'} ${r.sessCount>1?`(${r.sessCount} جلسات)`:''}</div>
      </div>
      <div class="rdi-right">
        <div class="rdi-earned">+${r.earned.toFixed(1)} د</div>
        ${r.dayDed>0?`<div class="rdi-deducted">-${r.dayDed.toFixed(1)} د</div>`:''}
      </div>
    </div>`).join('') : '<div class="empty-state">لا توجد بيانات</div>';

  const tl = document.getElementById('report-tx-list');
  const txs = userData.transactions.filter(t=>t.date.startsWith(ms)).reverse();
  tl.innerHTML = txs.length ? txs.map(t=>{
    const icon=t.type==='withdrawal'?'💵':t.type==='purchase'?'📦':'🚶';
    const amt=t.amount>0?`- ${t.amount.toFixed(1)} د`:'—';
    return `<div class="tx-item ${t.type}">
      <div class="tx-info">
        <div class="tx-desc">${icon} ${t.desc}</div>
        <div class="tx-meta">${formatDateShort(t.date)}</div>
      </div>
      <div class="tx-amount">${amt}</div>
    </div>`;
  }).join('') : '<div class="empty-state">لا توجد معاملات</div>';
}

// ===== PDF =====
function exportPDF() {
  const y=reportDate.getFullYear(), m=reportDate.getMonth();
  const ms=`${y}-${String(m+1).padStart(2,'0')}`;
  const MN=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const label=`${MN[m]} ${y}`;
  const s=userData.settings;
  let totalE=0,totalD=0,days=0;
  const rows=[];

  Object.keys(userData.attendance).filter(d=>d.startsWith(ms)).sort().forEach(dateStr=>{
    const hours = getTotalHours(dateStr);
    if(hours <= 0) return;
    const earned=s.salaryType==='hourly'?hours*(s.hourlyRate||0):(s.dailyRate||0);
    const dayTx=userData.transactions.filter(t=>t.date===dateStr&&t.amount>0);
    const dayDed=dayTx.reduce((sum,t)=>sum+t.amount,0);
    const firstIn=getFirstIn(dateStr), lastOut=getLastOut(dateStr);
    totalE+=earned; totalD+=dayDed; days++;
    rows.push({dateStr,hours,earned,dayDed,firstIn,lastOut});
  });

  const txs=userData.transactions.filter(t=>t.date.startsWith(ms)&&t.amount>0);
  const net=totalE-totalD;

  const html=`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="UTF-8"/>
<title>تقرير Waqti — ${label}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;800&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Tajawal',sans-serif;background:#fff;color:#1a1a2e;padding:2rem;direction:rtl}
  .hdr{text-align:center;border-bottom:3px solid #00C896;padding-bottom:1.5rem;margin-bottom:2rem}
  .hdr h1{font-size:1.8rem;color:#00C896} .hdr p{color:#666;margin-top:.3rem;font-size:.9rem}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin-bottom:2rem}
  .card{border-radius:10px;padding:1rem;text-align:center}
  .card.g{background:#e8faf5;border:1px solid #00C896}.card.r{background:#fff0f1;border:1px solid #ff5c6a}
  .card.b{background:#eef4ff;border:1px solid #4a90e2}.card.o{background:#fffbe6;border:1px solid #f5c842}
  .card .v{font-size:1.3rem;font-weight:800;margin-top:.3rem}.card .l{font-size:.75rem;color:#666}
  .card.g .v{color:#00C896}.card.r .v{color:#ff5c6a}.card.b .v{color:#4a90e2}.card.o .v{color:#b8950a}
  h2{font-size:1rem;font-weight:700;margin:1.5rem 0 .75rem;border-right:4px solid #00C896;padding-right:.5rem}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th{background:#00C896;color:#000;padding:.55rem .75rem;text-align:right;font-weight:700}
  td{padding:.5rem .75rem;border-bottom:1px solid #eee}
  tr:nth-child(even) td{background:#f9f9f9}
  .ded{color:#ff5c6a;font-weight:700}.net{color:#00C896;font-weight:800}
  .ftr{text-align:center;margin-top:2rem;font-size:.75rem;color:#aaa;border-top:1px solid #eee;padding-top:1rem}
  @media print{body{padding:1rem}}
</style></head><body>
<div class="hdr">
  <h1>⏱ Waqti — تقرير ${label}</h1>
  <p>${userData.name||currentUser} | طُبع: ${new Date().toLocaleDateString('ar-LY')}</p>
</div>
<div class="grid">
  <div class="card g"><div class="l">إجمالي الراتب</div><div class="v">${totalE.toFixed(1)} د</div></div>
  <div class="card r"><div class="l">إجمالي الخصومات</div><div class="v">${totalD.toFixed(1)} د</div></div>
  <div class="card b"><div class="l">صافي المستحق</div><div class="v">${net.toFixed(1)} د</div></div>
  <div class="card o"><div class="l">أيام العمل</div><div class="v">${days} يوم</div></div>
</div>
<h2>تفاصيل أيام العمل</h2>
<table>
  <thead><tr><th>التاريخ</th><th>أول حضور</th><th>آخر انصراف</th><th>الساعات</th><th>المكتسب</th><th>الخصومات</th><th>الصافي</th></tr></thead>
  <tbody>${rows.map(r=>`<tr>
    <td>${formatDateShort(r.dateStr)}</td><td>${r.firstIn||'—'}</td><td>${r.lastOut||'مفتوح'}</td>
    <td>${r.hours.toFixed(1)}</td><td>${r.earned.toFixed(1)} د</td>
    <td class="ded">${r.dayDed>0?r.dayDed.toFixed(1)+' د':'—'}</td>
    <td class="net">${(r.earned-r.dayDed).toFixed(1)} د</td>
  </tr>`).join('')}</tbody>
</table>
${txs.length?`<h2>المسحوبات والمشتريات</h2>
<table><thead><tr><th>التاريخ</th><th>النوع</th><th>الوصف</th><th>المبلغ</th></tr></thead>
<tbody>${txs.map(t=>`<tr>
  <td>${formatDateShort(t.date)}</td>
  <td>${t.type==='withdrawal'?'مسحوب نقدي':t.type==='purchase'?'بضاعة':'إذن خروج'}</td>
  <td>${t.desc}</td><td class="ded">${t.amount.toFixed(1)} د</td>
</tr>`).join('')}</tbody></table>`:''}
<div class="ftr">تم إنشاء هذا التقرير بواسطة Waqti</div>
</body></html>`;

  const w=window.open('','_blank');
  if(w){ w.document.write(html); w.document.close(); setTimeout(()=>w.print(),600); }
  showToast('📄 جاري فتح التقرير...');
}

// ===== SETTINGS =====
function loadSettings() {
  const s=userData.settings;
  document.getElementById('salary-type').value  = s.salaryType||'hourly';
  document.getElementById('hourly-rate').value  = s.hourlyRate||'';
  document.getElementById('daily-rate').value   = s.dailyRate||'';
  document.getElementById('work-start').value   = s.workStart||'08:00';
  document.getElementById('work-end').value     = s.workEnd||'17:00';
  document.getElementById('settings-name').value= userData.name||'';
  document.getElementById('settings-password').value='';
  toggleSalaryFields();
}

function toggleSalaryFields() {
  const t=document.getElementById('salary-type').value;
  document.getElementById('hourly-field').classList.toggle('hidden', t!=='hourly');
  document.getElementById('auto-calc-wrap').classList.toggle('hidden', t!=='hourly');
  document.getElementById('daily-field').classList.toggle('hidden', t!=='daily');
}

function calcHourlyRate() {
  const base=parseFloat(document.getElementById('base-salary').value)||0;
  const hrs =parseFloat(document.getElementById('work-hours-day').value)||0;
  const days=parseFloat(document.getElementById('work-days-month').value)||0;
  const res =document.getElementById('calc-result');
  if(base>0&&hrs>0&&days>0){
    calcedRate=base/(hrs*days);
    res.textContent=`قيمة الساعة = ${calcedRate.toFixed(2)} د`;
    res.classList.remove('hidden');
  } else { res.classList.add('hidden'); calcedRate=0; }
}

function applyCalcRate() {
  if(!calcedRate){showToast('⚠️ أدخل البيانات أولاً');return;}
  document.getElementById('hourly-rate').value=calcedRate.toFixed(2);
  showToast('✅ تم تطبيق '+calcedRate.toFixed(2)+' د/ساعة');
}

function saveSettings() {
  const salaryType=document.getElementById('salary-type').value;
  const hourlyRate=parseFloat(document.getElementById('hourly-rate').value)||0;
  const dailyRate =parseFloat(document.getElementById('daily-rate').value)||0;
  const workStart =document.getElementById('work-start').value;
  const workEnd   =document.getElementById('work-end').value;
  const newName   =document.getElementById('settings-name').value.trim();
  const newPass   =document.getElementById('settings-password').value;
  userData.settings={salaryType,hourlyRate,dailyRate,workStart,workEnd};
  if(newName) userData.name=newName;
  if(newPass){
    if(newPass.length<4){showToast('⚠️ كلمة السر لا تقل عن 4 أحرف');return;}
    const u=DB.getUsers(); u[currentUser].password=btoa(newPass); DB.saveUsers(u);
  }
  saveData();
  document.getElementById('user-name-display').textContent=(userData.name||currentUser);
  document.getElementById('user-avatar').textContent=(userData.name||currentUser).charAt(0).toUpperCase();
  const s=document.getElementById('settings-success');
  s.classList.remove('hidden'); setTimeout(()=>s.classList.add('hidden'),2500);
  showToast('✅ تم حفظ الإعدادات');
}

// ===== COUNTDOWN =====
function startCountdown() {
  stopCountdown();
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 30000);
}

function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  const bar = document.getElementById('countdown-bar');
  if (bar) bar.classList.add('hidden');
}

function updateCountdown() {
  const s   = userData?.settings;
  const bar = document.getElementById('countdown-bar');
  const cdT = document.getElementById('cd-time');
  if (!s?.workEnd || !bar || !cdT) return;
  const now     = new Date();
  const [eh,em] = s.workEnd.split(':').map(Number);
  const end     = new Date(); end.setHours(eh, em, 0, 0);
  const diffMs  = end - now;
  if (diffMs <= 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const totalMins = Math.floor(diffMs / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  cdT.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  bar.classList.toggle('almost', totalMins <= 30);
}

// ===== DAILY NOTE =====
function loadDailyNote(dateStr) {
  const noteEl = document.getElementById('daily-note');
  if (!noteEl) return;
  if (!userData.notes) userData.notes = {};
  noteEl.value = userData.notes[dateStr] || '';
}

function saveNote() {
  const today  = getTodayStr();
  const noteEl = document.getElementById('daily-note');
  if (!noteEl) return;
  if (!userData.notes) userData.notes = {};
  userData.notes[today] = noteEl.value;
  saveData();
}

// ===== ABSENCE =====
let currentAbsenceDay = null;

function markDay(type) {
  const today = getTodayStr();
  if (!userData.absences) userData.absences = {};
  const existing = userData.absences[today];
  if (existing?.type === type) {
    showConfirm(
      type==='vacation'?'🌴':'❌', 'إلغاء التسجيل',
      `هل تريد إلغاء ${type==='vacation'?'الإجازة':'الغياب'}؟`,
      () => { delete userData.absences[today]; saveData(); refreshAbsenceButtons(today); showToast('✅ تم الإلغاء'); }
    );
    return;
  }
  currentAbsenceType = type;
  currentAbsenceDay  = today;
  document.getElementById('absence-modal-title').textContent = type==='vacation'?'🌴 تسجيل إجازة':'❌ تسجيل غياب';
  document.getElementById('absence-reason').value = '';
  document.getElementById('absence-error').classList.add('hidden');
  document.getElementById('modal-absence').classList.remove('hidden');
}

function closeAbsenceModal(e) {
  if (!e || e.target.classList.contains('modal-overlay') || e.type==='click')
    document.getElementById('modal-absence').classList.add('hidden');
}

function saveAbsence() {
  const reason = document.getElementById('absence-reason').value.trim();
  if (!userData.absences) userData.absences = {};
  userData.absences[currentAbsenceDay] = {
    type: currentAbsenceType,
    reason: reason || (currentAbsenceType==='vacation'?'إجازة':'غياب')
  };
  saveData();
  document.getElementById('modal-absence').classList.add('hidden');
  refreshAbsenceButtons(currentAbsenceDay);
  showToast(currentAbsenceType==='vacation'?'🌴 تم تسجيل الإجازة':'❌ تم تسجيل الغياب');
}

function refreshAbsenceButtons(dateStr) {
  if (!userData.absences) userData.absences = {};
  const abs = userData.absences[dateStr];
  const vacBtn = document.querySelector('.absence-btn.vacation, .absence-btn.active-vacation');
  const absBtn = document.querySelector('.absence-btn.absent, .absence-btn.active-absent');
  if (!vacBtn || !absBtn) return;
  vacBtn.className = 'absence-btn ' + (abs?.type==='vacation'?'active-vacation':'vacation');
  absBtn.className = 'absence-btn ' + (abs?.type==='absent'?'active-absent':'absent');
}

// ===== CLEAR DATA =====
let clearStep = 0;

function confirmClearData() {
  clearStep = 1;
  showConfirm('⚠️', 'مسح جميع البيانات',
    'سيتم حذف كل الحضور والمعاملات نهائياً.\nهذا الإجراء لا يمكن التراجع عنه.',
    () => {
      clearStep = 2;
      setTimeout(() => {
        showConfirm('🔴', 'تأكيد نهائي',
          'آخر فرصة — سيُمسح كل شيء بلا رجعة.\nهل أنت متأكد تماماً؟',
          () => {
            userData.attendance   = {};
            userData.transactions = [];
            userData.notes        = {};
            userData.absences     = {};
            saveData();
            clearStep = 0;
            showToast('🗑️ تم مسح البيانات — جاري الإعادة...');
            setTimeout(() => location.reload(), 800);
          }
        );
      }, 300);
    }
  );
}

// ===== CHART =====
function renderChart(monthStr) {
  const canvas = document.getElementById('hours-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const y = parseInt(monthStr.split('-')[0]);
  const m = parseInt(monthStr.split('-')[1]) - 1;
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const hoursArr = [], colorsArr = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const hrs = getTotalHours(dateStr);
    const abs = userData.absences?.[dateStr];
    hoursArr.push(parseFloat(hrs.toFixed(1)));
    colorsArr.push(hrs>0 ? '#00C896' : abs?.type==='vacation' ? '#4a90e2' : abs?.type==='absent' ? '#ff5c6a' : '#2a3444');
  }

  const W = canvas.parentElement.clientWidth - 32;
  const H = 148;
  canvas.width = W; canvas.height = H;
  ctx.clearRect(0, 0, W, H);
  const maxH = Math.max(...hoursArr, 1);
  const barW = Math.max(2, Math.floor(W/daysInMonth)-2);
  const gap  = Math.floor(W/daysInMonth);

  ctx.strokeStyle='#2a3444'; ctx.lineWidth=0.5;
  for (let i=0; i<=4; i++) {
    const y2=H-20-(i/4)*(H-28);
    ctx.beginPath(); ctx.moveTo(0,y2); ctx.lineTo(W,y2); ctx.stroke();
  }
  hoursArr.forEach((h,i) => {
    const barH = h>0 ? Math.max(3,(h/maxH)*(H-28)) : 2;
    const x = i*gap+(gap-barW)/2;
    const y2 = H-20-barH;
    ctx.fillStyle=colorsArr[i];
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x,y2,barW,barH,2) : ctx.rect(x,y2,barW,barH);
    ctx.fill();
    if (i===0||(i+1)%5===0) {
      ctx.fillStyle='#4a5568'; ctx.font='9px Tajawal,sans-serif'; ctx.textAlign='center';
      ctx.fillText(i+1, x+barW/2, H-5);
    }
  });
}

// ===== CALENDAR =====
function renderCalendar(monthStr) {
  const el = document.getElementById('month-calendar');
  if (!el) return;
  const y = parseInt(monthStr.split('-')[0]);
  const m = parseInt(monthStr.split('-')[1]) - 1;
  const firstDay    = new Date(y,m,1).getDay();
  const daysInMonth = new Date(y,m+1,0).getDate();
  const todayStr    = getTodayStr();
  const dayNames    = ['أح','اث','ثل','أر','خم','جم','سب'];
  let html = '<div class="cal-grid">';
  dayNames.forEach(d => { html += `<div class="cal-day-name">${d}</div>`; });
  for (let i=0; i<firstDay; i++) html += '<div class="cal-day empty"></div>';
  for (let d=1; d<=daysInMonth; d++) {
    const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const hrs = getTotalHours(dateStr);
    const abs = userData.absences?.[dateStr];
    let cls = 'cal-day';
    if (hrs > 0)                    cls += ' present';
    else if (abs?.type==='vacation') cls += ' vacation';
    else if (abs?.type==='absent')   cls += ' absent';
    if (dateStr === todayStr)        cls += ' today';
    html += `<div class="${cls}">${d}</div>`;
  }
  html += `</div><div class="cal-legend">
    <div class="cal-legend-item"><div class="cal-dot present"></div>حضور</div>
    <div class="cal-legend-item"><div class="cal-dot absent"></div>غياب</div>
    <div class="cal-legend-item"><div class="cal-dot vacation"></div>إجازة</div>
  </div>`;
  el.innerHTML = html;
}

// ===== SHARE =====
function shareReport() {
  const y=reportDate.getFullYear(), m=reportDate.getMonth();
  const ms=`${y}-${String(m+1).padStart(2,'0')}`;
  const MN=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const label=`${MN[m]} ${y}`;
  const s=userData.settings;
  let totalE=0,totalD=0,days=0;
  Object.keys(userData.attendance).filter(d=>d.startsWith(ms)).forEach(dateStr=>{
    const hrs=getTotalHours(dateStr);
    if(hrs<=0) return;
    const earned=s.salaryType==='hourly'?hrs*(s.hourlyRate||0):(s.dailyRate||0);
    const dayDed=userData.transactions.filter(t=>t.date===dateStr&&t.amount>0).reduce((s,t)=>s+t.amount,0);
    totalE+=earned; totalD+=dayDed; days++;
  });
  const text=`📊 تقرير Waqti — ${label}\n👤 ${userData.name||currentUser}\n\n✅ أيام العمل: ${days} يوم\n💰 إجمالي الراتب: ${totalE.toFixed(1)} د\n📤 الخصومات: ${totalD.toFixed(1)} د\n💵 الصافي المستحق: ${(totalE-totalD).toFixed(1)} د\n\n— Waqti App`;
  if (navigator.share) { navigator.share({title:`تقرير ${label}`,text}).catch(()=>{}); }
  else { navigator.clipboard?.writeText(text).then(()=>showToast('📋 تم نسخ التقرير')); }
}

// ===== BACKUP =====
function exportBackup() {
  const backup={user:currentUser,data:userData,exportedAt:new Date().toISOString()};
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=`waqti-backup-${currentUser}-${getTodayStr()}.json`; a.click();
  URL.revokeObjectURL(url);
  showToast('💾 تم تصدير النسخة الاحتياطية');
}

function importBackup(event) {
  const file=event.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=(e)=>{
    try {
      const backup=JSON.parse(e.target.result);
      if(!backup.data){showToast('⚠️ ملف غير صحيح');return;}
      showConfirm('💾','استيراد النسخة الاحتياطية','سيتم استبدال بياناتك الحالية. هل تريد المتابعة؟',()=>{
        userData=backup.data; saveData(); navigateTo('home'); showToast('✅ تم استيراد البيانات');
      });
    } catch { showToast('⚠️ فشل قراءة الملف'); }
  };
  reader.readAsText(file);
  event.target.value='';
}

// ===== THEME =====
function initTheme() {
  const saved=localStorage.getItem('wt_theme');
  applyTheme(saved==='light'?'light':'dark');
}
function toggleTheme() { applyTheme(document.body.classList.contains('light')?'dark':'light'); }
function applyTheme(theme) {
  const isLight=theme==='light';
  document.body.classList.toggle('light',isLight);
  localStorage.setItem('wt_theme',theme);
  const btn=document.getElementById('theme-toggle-btn');
  const label=document.getElementById('theme-label');
  if(btn) btn.classList.toggle('light',isLight);
  if(label) label.textContent=isLight?'☀️ فاتح':'🌙 داكن';
}

// ===== HELPERS =====
function saveData() { DB.saveUserData(currentUser, userData); }

function getTodayStr() {
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getCurrentTimeStr() {
  const d=new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function calcHours(t1,t2) {
  if(!t1||!t2) return 0;
  const[h1,m1]=t1.split(':').map(Number);
  const[h2,m2]=t2.split(':').map(Number);
  return Math.max(0,(h2*60+m2-h1*60-m1)/60);
}
function calcHoursUntilNow(t1){ return calcHours(t1,getCurrentTimeStr()); }
function formatDateShort(dateStr) {
  const[y,m,d]=dateStr.split('-');
  const MN=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  return `${parseInt(d)} ${MN[parseInt(m)-1]} ${y}`;
}
function formatDateShort2(date) {
  const MN=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  return `${date.getDate()} ${MN[date.getMonth()]}`;
}
function formatTimeStr(time) {
  if(!time) return '';
  const[h,m]=time.split(':').map(Number);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} ${h<12?'ص':'م'}`;
}
function showError(el,msg){ el.textContent=msg; el.classList.remove('hidden'); }
function showToast(msg) {
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t=setTimeout(()=>t.classList.add('hidden'),2500);
}
