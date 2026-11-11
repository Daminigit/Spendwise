// Spendwise — minimal progressive enhancement. Every page works without JS.
(function () {
  'use strict';

  const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });

  /** "1,250.50" / "₹ 500" → paise (integer) or null if unparsable. */
  function toPaise(text) {
    const s = String(text || '').replace(/[₹,\s]/g, '');
    if (s === '') return 0;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const [whole, frac = ''] = s.split('.');
    return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  }

  // ── Live totals on the claim detail edit form ───────────────────────────────
  function initLiveTotals(form) {
    const recalc = () => {
      const sums = {};
      form.querySelectorAll('[data-money]').forEach((input) => {
        const key = input.dataset.money;
        const p = toPaise(input.value);
        input.classList.toggle('invalid', p === null);
        sums[key] = (sums[key] || 0) + (p || 0);
      });
      Object.entries(sums).forEach(([key, paise]) => {
        const el = document.querySelector(`[data-live-total="${key}"]`);
        if (el) el.textContent = inr.format(paise / 100);
      });
    };
    form.addEventListener('input', (e) => {
      if (e.target.matches('[data-money]')) recalc();
    });
  }

  // ── Receipt drag-and-drop / picker upload ───────────────────────────────────
  async function uploadReceipt(zone, file) {
    const status = zone.querySelector('[data-upload-status]');
    const setStatus = (msg, isError) => {
      if (!status) return;
      status.textContent = msg;
      status.classList.toggle('danger', Boolean(isError));
    };
    if (file.size > 10 * 1024 * 1024) return setStatus('File is larger than 10 MB.', true);

    const body = new FormData();
    body.append('receipt', file);
    if (zone.dataset.expenseId) body.append('expenseId', zone.dataset.expenseId);

    setStatus('Uploading…');
    zone.classList.add('busy');
    try {
      const res = await fetch('/upload/receipt', { method: 'POST', body, headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);

      const link = zone.querySelector('[data-receipt-link]');
      if (link) {
        const a = document.createElement('a');
        a.href = data.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'View receipt';
        a.setAttribute('data-receipt-link', '');
        link.replaceWith(a);
      }
      setStatus('Attached ✓');
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      zone.classList.remove('busy');
    }
  }

  function initDropzone(zone) {
    const input = zone.querySelector('[data-receipt-input]');
    if (input) {
      input.addEventListener('change', () => {
        if (input.files && input.files[0]) uploadReceipt(zone, input.files[0]);
        input.value = '';
      });
    }
    ['dragenter', 'dragover'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
      }),
    );
    zone.addEventListener('drop', (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) uploadReceipt(zone, file);
    });
  }

  // ── Copy to clipboard ───────────────────────────────────────────────────────
  function initCopy(btn) {
    btn.addEventListener('click', async () => {
      const target = document.querySelector(btn.dataset.copy);
      if (!target) return;
      const text = target.value || target.textContent;
      const original = btn.textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied ✓';
      } catch {
        if (target.select) target.select();
        btn.textContent = 'Press ⌘/Ctrl+C';
      }
      setTimeout(() => (btn.textContent = original), 2000);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-live-totals]').forEach(initLiveTotals);
    document.querySelectorAll('[data-dropzone]').forEach(initDropzone);
    document.querySelectorAll('[data-copy]').forEach(initCopy);

    // Confirm dangerous / irreversible actions
    document.querySelectorAll('form[data-confirm]').forEach((form) =>
      form.addEventListener('submit', (e) => {
        if (!window.confirm(form.dataset.confirm)) e.preventDefault();
      }),
    );

    // Auto-submit filter selects
    document.querySelectorAll('form[data-autosubmit] select').forEach((sel) =>
      sel.addEventListener('change', () => sel.form.submit()),
    );

    // "Select all" checkboxes
    document.querySelectorAll('[data-check-all]').forEach((all) =>
      all.addEventListener('change', () => {
        all.closest('form').querySelectorAll(`input[name="${all.dataset.checkAll}"]`).forEach((cb) => (cb.checked = all.checked));
      }),
    );
  });
})();
