import axios from 'axios';

// BASE_URL is "/" in dev and "/pos/" in the production build, so API calls hit
// /api/... locally and /pos/api/... behind the host proxy.
const api = axios.create({
  baseURL: `${import.meta.env.BASE_URL}api`,
  withCredentials: true,
});

// ATC operators must scope phase-2 endpoints to a company (contract §3,
// `x-pos-company`). The scope is set only from the ATC console and cleared on
// login/logout, so non-ATC sessions never carry the header.
api.interceptors.request.use((config) => {
  try {
    const raw = sessionStorage.getItem('pos.atcCompany');
    if (raw) {
      const { id } = JSON.parse(raw);
      if (id) config.headers['x-pos-company'] = id;
    }
  } catch {
    // sessionStorage unavailable/corrupt — send the request unscoped.
  }
  return config;
});

// Contract §3: 401 POS_UNAUTHENTICATED → go to login. Auth bootstrap calls
// (/auth/*) are excluded — AuthProvider handles those without a hard redirect
// (and the login page itself probes /auth/me).
api.interceptors.response.use(undefined, (err) => {
  const status = err?.response?.status;
  const url = err?.config?.url || '';
  if (status === 401 && !url.includes('/auth/')) {
    window.location.assign(`${import.meta.env.BASE_URL}login`);
  }
  return Promise.reject(err);
});

export const apiError = (err, fallback = 'Something went wrong') =>
  err?.response?.data?.error?.message || fallback;

export default api;
