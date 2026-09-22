import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Compass className="h-12 w-12 text-slate-300" />
      <h1 className="mt-4 text-2xl font-bold text-pos-ink">Page not found</h1>
      <p className="mt-2 text-sm text-slate-500">The page you requested does not exist in VEXO Connect.</p>
      <Link to="/" className="btn-primary mt-6">Go to home</Link>
    </div>
  );
}
