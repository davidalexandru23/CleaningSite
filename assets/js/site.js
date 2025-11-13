(function () {
  const consentKey = 'acs-consent';
  const defaultConsent = { essential: true, external: false };

  document.addEventListener('DOMContentLoaded', () => {
    const yearEl = document.getElementById('year');
    if (yearEl) {
      yearEl.textContent = new Date().getFullYear();
    }

    initConsentControls();
    initContactForm();
    initGdprForm();
  });

  function initConsentControls() {
    const cookieBanner = document.getElementById('cookieBanner');
    const acceptEssentialBtn = document.getElementById('acceptEssentialCookies');
    const acceptAllBtn = document.getElementById('acceptAllCookies');
    const mapWrapper = document.querySelector('[data-map-src]');
    const manageConsentButtons = ['manageConsent', 'manageConsentPrivacy', 'manageConsentPrivacyBlock']
      .map((id) => document.getElementById(id))
      .filter(Boolean);

    if (!cookieBanner && !mapWrapper) {
      return;
    }

    acceptEssentialBtn?.addEventListener('click', () => {
      updateConsent({ external: false });
      hideBanner();
    });

    acceptAllBtn?.addEventListener('click', () => {
      updateConsent({ external: true });
      hideBanner();
    });

    manageConsentButtons.forEach((btn) => btn.addEventListener('click', showBanner));

    mapWrapper?.addEventListener('click', (event) => {
      if (event.target?.dataset?.consentAction === 'enable-external') {
        updateConsent({ external: true });
        hideBanner();
      }
    });

    const hasStoredConsent = Boolean(localStorage.getItem(consentKey));
    if (!hasStoredConsent) {
      showBanner();
    }
    applyConsentState();

    function renderMap() {
      if (!mapWrapper || mapWrapper.querySelector('iframe')) {
        return;
      }
      const iframe = document.createElement('iframe');
      iframe.src = mapWrapper.dataset.mapSrc;
      iframe.loading = 'lazy';
      iframe.referrerPolicy = 'no-referrer-when-downgrade';
      iframe.setAttribute('allowfullscreen', '');
      iframe.title = 'Hartă Google';
      mapWrapper.innerHTML = '';
      mapWrapper.appendChild(iframe);
    }

    function renderMapPlaceholder() {
      if (!mapWrapper) {
        return;
      }
      mapWrapper.innerHTML = `
        <div class="map-placeholder">
          <i class="bi bi-geo-alt"></i>
          <p>Conținutul Google Maps este dezactivat până la acceptarea cookie-urilor externe.</p>
          <button class="btn btn-outline-primary" data-consent-action="enable-external">
            Activează harta
          </button>
        </div>
      `;
    }

    function applyConsentState() {
      const consent = getStoredConsent();
      if (mapWrapper) {
        if (consent.external) {
          renderMap();
        } else {
          renderMapPlaceholder();
        }
      }
    }

    function showBanner() {
      cookieBanner?.classList.remove('d-none');
    }

    function hideBanner() {
      cookieBanner?.classList.add('d-none');
    }

    function updateConsent(changes) {
      const updated = { ...defaultConsent, ...getStoredConsent(), ...changes };
      localStorage.setItem(consentKey, JSON.stringify(updated));
      applyConsentState();
    }

    function getStoredConsent() {
      try {
        return JSON.parse(localStorage.getItem(consentKey)) || { ...defaultConsent };
      } catch {
        return { ...defaultConsent };
      }
    }
  }

  function initContactForm() {
    const contactForm = document.getElementById('contactForm');
    if (!contactForm) {
      return;
    }

    const successAlert = document.getElementById('formSuccess');
    const errorAlert = document.getElementById('formError');
    const submitButton = contactForm.querySelector('button[type="submit"]');
    const errorMessageTarget = errorAlert?.querySelector('span') || errorAlert;
    const CONTACT_ENDPOINT =
      window.location.protocol === 'file:' ? 'http://localhost:4000/api/contact' : '/api/contact';

    contactForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      successAlert?.classList.add('d-none');
      errorAlert?.classList.add('d-none');
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Se trimite...';
      }

      const formData = new FormData(contactForm);
      const payload = {
        fullName: formData.get('fullName')?.trim(),
        company: formData.get('company')?.trim(),
        email: formData.get('email')?.trim(),
        phone: formData.get('phone')?.trim(),
        message: formData.get('message')?.trim(),
        consent: formData.get('consent') === 'true',
        honeypot: formData.get('honeypot')?.trim() || ''
      };

      try {
        const response = await fetch(CONTACT_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          const validationMsg = result?.errors ? Object.values(result.errors).join(' ') : null;
          throw new Error(validationMsg || result?.message || 'Nu am putut trimite mesajul.');
        }

        successAlert?.classList.remove('d-none');
        contactForm.reset();
        window.setTimeout(() => successAlert?.classList.add('d-none'), 6000);
      } catch (error) {
        if (errorMessageTarget) {
          errorMessageTarget.textContent = error?.message || 'Nu am putut trimite mesajul.';
        }
        errorAlert?.classList.remove('d-none');
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = 'Trimite';
        }
      }
    });
  }

  function initGdprForm() {
    const gdprForm = document.getElementById('gdprForm');
    if (!gdprForm) {
      return;
    }

    const gdprSuccess = document.getElementById('gdprSuccess');
    const gdprError = document.getElementById('gdprError');
    const submitButton = gdprForm.querySelector('button[type="submit"]');
    const defaultErrorText = gdprError?.textContent || 'Nu am putut înregistra cererea.';
    const GDPR_ENDPOINT =
      window.location.protocol === 'file:'
        ? 'http://localhost:4000/api/contact/gdpr-request'
        : '/api/contact/gdpr-request';

    gdprForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      gdprSuccess?.classList.add('d-none');
      gdprError?.classList.add('d-none');
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Se trimite...';
      }

      const formData = new FormData(gdprForm);
      const payload = {
        fullName: formData.get('fullName')?.trim(),
        email: formData.get('email')?.trim(),
        requestType: formData.get('requestType'),
        message: formData.get('message')?.trim()
      };

      try {
        const response = await fetch(GDPR_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(result?.message || 'Eroare la transmitere.');
        }

        gdprSuccess?.classList.remove('d-none');
        gdprForm.reset();
      } catch (error) {
        if (gdprError) {
          gdprError.textContent = error?.message || defaultErrorText;
          gdprError.classList.remove('d-none');
        }
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = 'Trimite solicitarea';
        }
      }
    });
  }
})();
