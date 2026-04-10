/* ============================================================
   REVAMP DIGITAL AI — main.js
   Handles: navbar scroll, mobile menu, scroll-to-top,
            lead form validation + submit, fade-in animations,
            smooth anchor scrolling, active nav detection
   ============================================================ */

'use strict';

/* ── Audit teaser: redirect to audit page with URL ── */
function goAudit() {
  const input = document.getElementById('teaserUrl');
  let url = input ? input.value.trim().replace(/\s+/g,'').replace(/^\/+/,'') : '';
  if (!url) { if (input) input.focus(); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  // Extract just the hostname for a clean URL
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    window.location.href = '/audit/' + host;
  } catch(e) {
    window.location.href = '/audit/' + url.replace(/^https?:\/\//i,'').replace(/^www\./,'');
  }
}

/* ── Navbar: solidify on scroll ── */
(function () {
  const navbar = document.getElementById('navbar');
  if (!navbar) return;
  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 48);
  }, { passive: true });
})();

/* ── Mobile hamburger toggle ── */
(function () {
  const toggle = document.getElementById('navToggle');
  const drawer = document.getElementById('navMobile');
  if (!toggle || !drawer) return;

  toggle.addEventListener('click', () => {
    const isOpen = drawer.classList.toggle('open');
    toggle.classList.toggle('open', isOpen);
    document.body.style.overflow = isOpen ? 'hidden' : '';
  });

  // Close when any link is clicked
  drawer.querySelectorAll('a').forEach(link =>
    link.addEventListener('click', () => {
      drawer.classList.remove('open');
      toggle.classList.remove('open');
      document.body.style.overflow = '';
    })
  );

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!navbar.contains(e.target)) {
      drawer.classList.remove('open');
      toggle.classList.remove('open');
      document.body.style.overflow = '';
    }
  });
})();

/* ── Active nav link highlighting ── */
(function () {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a, .nav-mobile a').forEach(link => {
    const href = (link.getAttribute('href') || '').split('#')[0];
    if (href === page || (page === '' && href === 'index.html')) {
      link.classList.add('active');
    }
  });
})();

/* ── Scroll-to-top button ── */
(function () {
  const btn = document.getElementById('scrollTop');
  if (!btn) return;
  window.addEventListener('scroll', () => {
    btn.classList.toggle('visible', window.scrollY > 450);
  }, { passive: true });
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
})();

/* ── Smooth anchor scrolling (offset for fixed navbar) ── */
(function () {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      const id     = this.getAttribute('href').slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      const offset = (document.getElementById('navbar')?.offsetHeight || 72) + 8;
      const top = target.getBoundingClientRect().top + window.pageYOffset - offset;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  });
})();

/* ── Intersection Observer — fade-in on scroll ── */
(function () {
  const items = document.querySelectorAll('.fade-in');
  if (!items.length) return;

  const obs = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;

      // Stagger siblings within the same grid parent
      const siblings = [...entry.target.parentElement.querySelectorAll('.fade-in:not(.visible)')];
      const idx      = siblings.indexOf(entry.target);
      const delay    = Math.min(idx * 90, 400); // cap stagger at 400ms

      setTimeout(() => entry.target.classList.add('visible'), delay);
      obs.unobserve(entry.target);
    });
  }, { threshold: 0.10, rootMargin: '0px 0px -40px 0px' });

  items.forEach(el => obs.observe(el));
})();

/* ── Lead / Contact Form handler ── */
(function () {
  document.querySelectorAll('[data-lead-form]').forEach(form => {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();

      // ── Validation: highlight empty required fields ──
      let isValid = true;
      form.querySelectorAll('[required]').forEach(field => {
        field.style.borderColor = '';
        if (!field.value.trim()) {
          field.style.borderColor = '#ef4444';
          field.style.boxShadow   = '0 0 0 3px rgba(239,68,68,0.12)';
          isValid = false;
          // Reset red border once user starts typing
          field.addEventListener('input', () => {
            field.style.borderColor = '';
            field.style.boxShadow   = '';
          }, { once: true });
        }
      });

      // ── Validation: goals field must be at least 10 words ──
      const goalsField = form.querySelector('[name="goals"]');
      if (goalsField) {
        const wordCount = goalsField.value.trim().split(/\s+/).filter(w => w).length;
        if (wordCount < 10) {
          goalsField.style.borderColor = '#ef4444';
          goalsField.style.boxShadow   = '0 0 0 3px rgba(239,68,68,0.12)';
          goalsField.placeholder = 'Please describe your challenge in at least 10 words…';
          goalsField.addEventListener('input', () => {
            goalsField.style.borderColor = '';
            goalsField.style.boxShadow   = '';
          }, { once: true });
          isValid = false;
        }
      }

      if (!isValid) {
        // Shake the submit button to signal error
        const submitBtn = form.querySelector('[type="submit"]');
        submitBtn.style.animation = 'none';
        void submitBtn.offsetHeight;
        submitBtn.style.animation = 'shake 0.4s ease';
        return;
      }

      // ── Loading state ──
      const submitBtn = form.querySelector('[type="submit"]');
      const origText  = submitBtn.innerHTML;
      submitBtn.disabled   = true;
      submitBtn.innerHTML  = 'Sending…';

      // ── Submit to backend ──
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form)))
      });

      if (!res.ok) {
        showToast('Something went wrong. Please try again.', 'error');
        submitBtn.disabled  = false;
        submitBtn.innerHTML = origText;
        return;
      }
      // ─────────────────────────────────────────────────

      submitBtn.disabled  = false;
      submitBtn.innerHTML = origText;

      // ── Show success state ──
      const successEl = form.parentElement.querySelector('.form-success');
      if (successEl) {
        form.style.display          = 'none';
        successEl.style.display     = 'block';
      } else {
        showToast('Message sent! We\'ll be in touch soon.', 'success');
      }

      form.reset();
    });
  });
})();

/* ── Toast notification ── */
function showToast(message, type = 'success') {
  document.querySelector('.rda-toast')?.remove();

  const toast = document.createElement('div');
  toast.className = 'rda-toast';
  toast.textContent = message;
  Object.assign(toast.style, {
    position:     'fixed',
    bottom:       '32px',
    left:         '50%',
    transform:    'translateX(-50%) translateY(80px)',
    background:   type === 'success' ? '#1F7A8C' : '#ef4444',
    color:        '#fff',
    padding:      '13px 28px',
    borderRadius: '10px',
    fontFamily:   "'Poppins', sans-serif",
    fontWeight:   '600',
    fontSize:     '0.9rem',
    boxShadow:    '0 8px 30px rgba(0,0,0,0.18)',
    zIndex:       '9999',
    transition:   'transform 0.3s ease, opacity 0.3s ease',
    opacity:      '0',
    whiteSpace:   'nowrap',
  });

  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.transform = 'translateX(-50%) translateY(0)';
    toast.style.opacity   = '1';
  });
  setTimeout(() => {
    toast.style.transform = 'translateX(-50%) translateY(80px)';
    toast.style.opacity   = '0';
    setTimeout(() => toast.remove(), 350);
  }, 4000);
}

/* ── Inject keyframes once ── */
(function () {
  if (document.getElementById('rda-keyframes')) return;
  const style = document.createElement('style');
  style.id = 'rda-keyframes';
  style.textContent = `
    @keyframes shake {
      0%,100%{ transform: translateX(0) }
      20%    { transform: translateX(-8px) }
      40%    { transform: translateX(8px) }
      60%    { transform: translateX(-5px) }
      80%    { transform: translateX(5px) }
    }
  `;
  document.head.appendChild(style);
})();

/* ── Marquee pause on hover ── */
(function () {
  const strip = document.querySelector('.hero-industries');
  const inner = document.querySelector('.hero-industries-inner');
  if (!strip || !inner) return;
  strip.addEventListener('mouseenter', () => { inner.style.animationPlayState = 'paused'; });
  strip.addEventListener('mouseleave', () => { inner.style.animationPlayState = 'running'; });
})();
