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

/* ── WhatsApp floating chat button ── */
(function () {
  const WA_NUMBER  = '13852532318';
  const WA_MESSAGE = encodeURIComponent("Hi! I found you on gorevamp.ai and I'd love to learn more.");
  const WA_URL     = `https://wa.me/${WA_NUMBER}?text=${WA_MESSAGE}`;

  const style = document.createElement('style');
  style.textContent = `
    /* Wrap both fixed buttons so they stack cleanly */
    .wa-stack {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 9998;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 10px;
    }

    /* WhatsApp pill */
    .wa-btn {
      display: flex;
      align-items: center;
      gap: 0;
      background: #25d366;
      border-radius: 50px;
      width: 44px;
      height: 44px;
      padding: 0;
      justify-content: center;
      box-shadow: 0 4px 20px rgba(37,211,102,0.4), 0 2px 8px rgba(0,0,0,0.18);
      text-decoration: none;
      overflow: hidden;
      transition: width 0.28s ease, box-shadow 0.2s ease, transform 0.2s ease;
      position: relative;
    }
    .wa-btn:hover {
      width: 190px;
      transform: translateY(-2px);
      box-shadow: 0 8px 28px rgba(37,211,102,0.5), 0 4px 10px rgba(0,0,0,0.2);
    }
    .wa-btn svg {
      width: 26px;
      height: 26px;
      flex-shrink: 0;
      margin-left: 9px;
      transition: margin 0.28s ease;
    }
    .wa-btn:hover svg {
      margin-left: 12px;
    }
    .wa-btn-text {
      font-family: 'Poppins', sans-serif;
      font-size: 0.82rem;
      font-weight: 700;
      color: #fff;
      white-space: nowrap;
      opacity: 0;
      max-width: 0;
      overflow: hidden;
      padding-left: 0;
      transition: opacity 0.15s ease, max-width 0.28s ease, padding 0.28s ease;
    }
    .wa-btn:hover .wa-btn-text {
      opacity: 1;
      max-width: 140px;
      padding-left: 8px;
      padding-right: 14px;
    }
    /* Pulse dot */
    .wa-pulse {
      position: absolute;
      top: 5px;
      right: 5px;
      width: 9px;
      height: 9px;
      background: #fff;
      border-radius: 50%;
      animation: waPulse 2s ease-in-out infinite;
    }
    .wa-btn:hover .wa-pulse { opacity: 0; }
    @keyframes waPulse {
      0%,100% { transform: scale(1);   opacity: 0.85; }
      50%      { transform: scale(1.6); opacity: 0.3; }
    }

    /* Move scroll-to-top inside the stack */
    .wa-stack .scroll-top {
      position: static !important;
      opacity: 1 !important;
      visibility: visible !important;
      display: none; /* managed by JS below */
    }
  `;
  document.head.appendChild(style);

  // Create wrapper stack
  const stack = document.createElement('div');
  stack.className = 'wa-stack';

  // WhatsApp button
  const btn = document.createElement('a');
  btn.className = 'wa-btn';
  btn.href      = WA_URL;
  btn.target    = '_blank';
  btn.rel       = 'noopener noreferrer';
  btn.setAttribute('aria-label', 'Chat with us on WhatsApp');
  btn.innerHTML = `
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M16 3C8.82 3 3 8.82 3 16c0 2.3.6 4.46 1.65 6.33L3 29l6.87-1.8A13 13 0 0016 29c7.18 0 13-5.82 13-13S23.18 3 16 3z" fill="#fff"/>
      <path d="M21.9 19.3c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.48-1.76-1.66-2.06-.17-.3-.02-.46.13-.61.14-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.05 1.03-1.05 2.5s1.08 2.9 1.22 3.1c.15.2 2.12 3.23 5.13 4.4.72.31 1.28.5 1.72.64.72.23 1.38.2 1.9.12.58-.09 1.77-.72 2.02-1.42.25-.7.25-1.29.17-1.42-.07-.12-.27-.2-.57-.35z" fill="#25d366"/>
    </svg>
    <span class="wa-btn-text">Chat on WhatsApp</span>
    <span class="wa-pulse"></span>
  `;
  stack.appendChild(btn);

  // Move existing scroll-to-top button into the stack
  document.addEventListener('DOMContentLoaded', () => {}, { once: true });
  const moveScrollTop = () => {
    const scrollBtn = document.getElementById('scrollTop');
    if (scrollBtn) {
      // Remove its fixed positioning — stack handles layout
      scrollBtn.style.position = 'static';
      scrollBtn.style.bottom   = '';
      scrollBtn.style.right    = '';
      scrollBtn.style.zIndex   = '';
      // Insert scroll button BELOW the WhatsApp button in the stack (order: WA on top, scroll below)
      stack.appendChild(scrollBtn);
    }
    document.body.appendChild(stack);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', moveScrollTop);
  } else {
    moveScrollTop();
  }
})();
