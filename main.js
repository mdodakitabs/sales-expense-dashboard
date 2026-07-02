'use strict';

/* =========================================================
   LEDGER — app.js
   Modular, framework-free dashboard logic.
   Modules: Store (data + localStorage), Stats, Chart, Table, Modal.
   ========================================================= */

const STORAGE_KEY = 'ledger.transactions';
const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

/* =========================================================
   STORE — single source of truth for transaction data
   ========================================================= */
const Store = {
  transactions: [],
  listeners: [],

  init() {
    this.load();
    if (this.transactions.length === 0) this.seed();
  },

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.transactions = raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.error('Failed to load transactions from storage:', err);
      this.transactions = [];
    }
  },

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.transactions));
    } catch (err) {
      console.error('Failed to save transactions to storage:', err);
      Toast.show('Could not save — storage may be full.', 'error');
    }
  },

  // Seed a few months of realistic demo data so the dashboard
  // isn't empty on first load.
  seed() {
    const cats = {
      income: ['Consulting', 'Product Sales', 'Retainer'],
      expense: ['Software', 'Marketing', 'Office', 'Contractors'],
    };
    const now = new Date();
    const demo = [];
    for (let m = 5; m >= 0; m--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const entriesThisMonth = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < entriesThisMonth; i++) {
        const isIncome = Math.random() > 0.45;
        const type = isIncome ? 'income' : 'expense';
        const category = cats[type][Math.floor(Math.random() * cats[type].length)];
        const day = 1 + Math.floor(Math.random() * 26);
        const amount = isIncome
          ? Math.round((800 + Math.random() * 4200) * 100) / 100
          : Math.round((60 + Math.random() * 1400) * 100) / 100;
        demo.push({
          id: this.makeId(),
          type,
          category,
          description: `${category} ${isIncome ? 'payment' : 'expense'}`,
          amount,
          date: new Date(monthDate.getFullYear(), monthDate.getMonth(), day).toISOString().slice(0, 10),
        });
      }
    }
    this.transactions = demo;
    this.save();
  },

  makeId() {
    return crypto.randomUUID ? crypto.randomUUID() : `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  },

  add(transaction) {
    this.transactions.unshift({ id: this.makeId(), ...transaction });
    this.save();
    this.emit();
  },

  remove(id) {
    this.transactions = this.transactions.filter((t) => t.id !== id);
    this.save();
    this.emit();
  },

  categories() {
    return [...new Set(this.transactions.map((t) => t.category))].sort();
  },

  totals() {
    return this.transactions.reduce(
      (acc, t) => {
        if (t.type === 'income') acc.revenue += t.amount;
        else acc.expenses += t.amount;
        return acc;
      },
      { revenue: 0, expenses: 0 }
    );
  },

  // Aggregates the last 6 calendar months into { labels, revenue[], expenses[] }
  monthlyTrend() {
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString(undefined, { month: 'short' }), revenue: 0, expenses: 0 });
    }
    const byKey = Object.fromEntries(months.map((m) => [m.key, m]));

    this.transactions.forEach((t) => {
      const d = new Date(t.date);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const bucket = byKey[key];
      if (!bucket) return; // outside the visible 6-month window
      if (t.type === 'income') bucket.revenue += t.amount;
      else bucket.expenses += t.amount;
    });

    return {
      labels: months.map((m) => m.label),
      revenue: months.map((m) => Math.round(m.revenue * 100) / 100),
      expenses: months.map((m) => Math.round(m.expenses * 100) / 100),
    };
  },

  // Simple pub/sub so UI modules re-render on data changes
  subscribe(fn) { this.listeners.push(fn); },
  emit() { this.listeners.forEach((fn) => fn()); },
};

/* =========================================================
   TOAST — lightweight confirmation / error messages
   ========================================================= */
const Toast = {
  el: null,
  timer: null,

  init() { this.el = $('#toast'); },

  show(message, kind = 'success') {
    if (!this.el) return;
    clearTimeout(this.timer);
    this.el.textContent = message;
    this.el.className = `toast is-visible is-${kind}`;
    this.timer = setTimeout(() => this.el.classList.remove('is-visible'), 2600);
  },
};

/* =========================================================
   STATS — the 3 summary cards + sidebar figure
   ========================================================= */
const Stats = {
  els: {},

  init() {
    this.els = {
      revenue: $('#statRevenue'),
      expenses: $('#statExpenses'),
      profit: $('#statProfit'),
      profitCard: $('#profitCard'),
      sidebarNet: $('#sidebarNet'),
      sidebarCaption: $('#sidebarCaption'),
    };
    Store.subscribe(() => this.render());
    this.render();
  },

  render() {
    const { revenue, expenses } = Store.totals();
    const profit = revenue - expenses;

    this.els.revenue.textContent = CURRENCY.format(revenue);
    this.els.expenses.textContent = CURRENCY.format(expenses);
    this.els.profit.textContent = CURRENCY.format(profit);
    this.els.profitCard.classList.toggle('is-negative', profit < 0);

    this.els.sidebarNet.textContent = CURRENCY.format(profit);
    this.els.sidebarCaption.textContent = profit >= 0 ? 'net position (positive)' : 'net position (negative)';
  },
};

/* =========================================================
   CHART — monthly revenue vs expenses (Chart.js)
   ========================================================= */
const TrendChart = {
  instance: null,

  init() {
    if (typeof Chart === 'undefined') {
      console.error('Chart.js failed to load — check your network connection to the CDN.');
      return;
    }
    Store.subscribe(() => this.render());
    this.render();
  },

  render() {
    if (typeof Chart === 'undefined') return;
    const ctx = $('#trendChart');
    if (!ctx) return;

    const { labels, revenue, expenses } = Store.monthlyTrend();
    const styles = getComputedStyle(document.body);
    const emerald = styles.getPropertyValue('--emerald').trim();
    const rose = styles.getPropertyValue('--rose').trim();
    const gridColor = styles.getPropertyValue('--chart-grid').trim();
    const textColor = styles.getPropertyValue('--text-dim').trim();

    if (this.instance) {
      this.instance.data.labels = labels;
      this.instance.data.datasets[0].data = revenue;
      this.instance.data.datasets[1].data = expenses;
      this.instance.update();
      return;
    }

    this.instance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Revenue',
            data: revenue,
            backgroundColor: emerald,
            borderRadius: 6,
            maxBarThickness: 28,
          },
          {
            label: 'Expenses',
            data: expenses,
            backgroundColor: rose,
            borderRadius: 6,
            maxBarThickness: 28,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => `${item.dataset.label}: ${CURRENCY.format(item.raw)}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: textColor } },
          y: {
            grid: { color: gridColor },
            ticks: { color: textColor, callback: (v) => `$${v >= 1000 ? `${v / 1000}k` : v}` },
          },
        },
      },
    });
  },
};

/* =========================================================
   TABLE — search, filter, render, delete
   ========================================================= */
const Table = {
  els: {},
  search: '',
  category: 'all',

  init() {
    this.els = {
      body: $('#tableBody'),
      search: $('#searchInput'),
      filter: $('#categoryFilter'),
      count: $('#rowCount'),
      empty: $('#emptyState'),
    };

    Store.subscribe(() => { this.renderCategoryOptions(); this.render(); });

    this.els.search.addEventListener('input', (e) => {
      this.search = e.target.value.trim().toLowerCase();
      this.render();
    });

    this.els.filter.addEventListener('change', (e) => {
      this.category = e.target.value;
      this.render();
    });

    this.els.body.addEventListener('click', (e) => {
      const btn = e.target.closest('.row-delete');
      if (!btn) return;
      const id = btn.closest('tr').dataset.id;
      Store.remove(id);
      Toast.show('Transaction removed.', 'success');
    });

    this.renderCategoryOptions();
    this.render();
  },

  renderCategoryOptions() {
    const current = this.els.filter.value || 'all';
    const cats = Store.categories();
    this.els.filter.innerHTML = ['<option value="all">All categories</option>']
      .concat(cats.map((c) => `<option value="${this.escape(c)}">${this.escape(c)}</option>`))
      .join('');
    // Preserve selection if the category still exists
    this.els.filter.value = cats.includes(current) ? current : 'all';
    this.category = this.els.filter.value;

    // Also refresh the <datalist> used by the add-transaction form
    const datalist = $('#categoryOptions');
    if (datalist) {
      datalist.innerHTML = cats.map((c) => `<option value="${this.escape(c)}"></option>`).join('');
    }
  },

  visibleRows() {
    return Store.transactions
      .filter((t) => this.category === 'all' || t.category === this.category)
      .filter((t) => {
        if (!this.search) return true;
        const haystack = `${t.description} ${t.category}`.toLowerCase();
        return haystack.includes(this.search);
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  },

  render() {
    const rows = this.visibleRows();

    this.els.body.innerHTML = rows.map((t) => `
      <tr data-id="${t.id}">
        <td><span class="type-pill type-pill-${t.type}">${t.type === 'income' ? 'Income' : 'Expense'}</span></td>
        <td>${this.escape(t.category)}</td>
        <td>${this.formatDate(t.date)}</td>
        <td class="align-right amount-cell amount-${t.type}">${t.type === 'expense' ? '-' : '+'}${CURRENCY.format(t.amount)}</td>
        <td class="align-right"><button class="row-delete" aria-label="Delete transaction">Remove</button></td>
      </tr>
    `).join('');

    this.els.empty.classList.toggle('is-visible', rows.length === 0);
    this.els.count.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;
  },

  formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  },

  escape(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};

/* =========================================================
   MODAL — add-transaction form with validation
   ========================================================= */
const Modal = {
  els: {},
  type: 'income',

  init() {
    this.els = {
      overlay: $('#modalOverlay'),
      form: $('#transactionForm'),
      typeToggle: $('.type-toggle'),
      typeInput: $('#typeInput'),
      desc: $('#descInput'),
      category: $('#categoryInput'),
      amount: $('#amountInput'),
      date: $('#dateInput'),
    };

    $('#openAddBtn').addEventListener('click', () => this.open());
    $('#openAddBtnMobile').addEventListener('click', () => this.open());
    $('#closeModalBtn').addEventListener('click', () => this.close());
    $('#cancelModalBtn').addEventListener('click', () => this.close());

    this.els.overlay.addEventListener('click', (e) => {
      if (e.target === this.els.overlay) this.close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.els.overlay.classList.contains('is-open')) this.close();
    });

    this.els.typeToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('.type-btn');
      if (!btn) return;
      this.type = btn.dataset.type;
      this.els.typeInput.value = this.type;
      $$('.type-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    });

    this.els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSubmit();
    });
  },

  open() {
    this.els.form.reset();
    this.clearErrors();
    this.type = 'income';
    this.els.typeInput.value = 'income';
    $$('.type-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.type === 'income'));
    this.els.date.value = new Date().toISOString().slice(0, 10);
    this.els.overlay.classList.add('is-open');
    setTimeout(() => this.els.desc.focus(), 100);
  },

  close() {
    this.els.overlay.classList.remove('is-open');
  },

  clearErrors() {
    $$('.field-error').forEach((el) => (el.textContent = ''));
    $$('.field').forEach((el) => el.classList.remove('has-error'));
  },

  // Returns true if valid; otherwise writes inline error messages.
  validate() {
    this.clearErrors();
    let valid = true;

    const setError = (inputEl, errorId, message) => {
      $(`#${errorId}`).textContent = message;
      inputEl.closest('.field').classList.add('has-error');
      valid = false;
    };

    const description = this.els.desc.value.trim();
    if (!description) setError(this.els.desc, 'descError', 'Description is required.');

    const category = this.els.category.value.trim();
    if (!category) setError(this.els.category, 'categoryError', 'Category is required.');

    const amount = parseFloat(this.els.amount.value);
    if (Number.isNaN(amount) || amount <= 0) {
      setError(this.els.amount, 'amountError', 'Enter an amount greater than 0.');
    }

    const date = this.els.date.value;
    if (!date) {
      setError(this.els.date, 'dateError', 'Date is required.');
    } else if (new Date(date) > new Date()) {
      setError(this.els.date, 'dateError', 'Date cannot be in the future.');
    }

    return valid;
  },

  handleSubmit() {
    if (!this.validate()) {
      Toast.show('Please fix the highlighted fields.', 'error');
      return;
    }

    Store.add({
      type: this.type,
      description: this.els.desc.value.trim(),
      category: this.els.category.value.trim(),
      amount: Math.round(parseFloat(this.els.amount.value) * 100) / 100,
      date: this.els.date.value,
    });

    Toast.show(`${this.type === 'income' ? 'Income' : 'Expense'} added successfully.`, 'success');
    this.close();
  },
};

/* =========================================================
   SIDEBAR NAV (smooth-scroll to the relevant section)
   ========================================================= */
function initNav() {
  const map = { dashboard: '.stats-row', analytics: '.chart-card', settings: '.table-card' };
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b === btn));
      const target = document.querySelector(map[btn.dataset.panel]);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

/* =========================================================
   HEADER DATE
   ========================================================= */
function initHeader() {
  $('#dateLine').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

/* =========================================================
   BOOT
   ========================================================= */
document.addEventListener('DOMContentLoaded', () => {
  try {
    Store.init();
    Toast.init();
    Stats.init();
    TrendChart.init();
    Table.init();
    Modal.init();
    initNav();
    initHeader();
  } catch (err) {
    console.error('Dashboard failed to initialize:', err);
  }
});