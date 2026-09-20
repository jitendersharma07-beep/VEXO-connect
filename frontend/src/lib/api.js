import axios from 'axios';

// BASE_URL is "/" in dev and "/pos/" in the production build, so API calls hit
// /api/... locally and /pos/api/... behind the host proxy.
const api = axios.create({
  baseURL: `${import.meta.env.BASE_URL}api`,
  withCredentials: true,
});

export const apiError = (err, fallback = 'Something went wrong') =>
  err?.response?.data?.error?.message || fallback;

export default api;
