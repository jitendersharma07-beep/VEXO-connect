import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Armchair, Check, Eye, Image as ImageIcon, Layers, Pencil, Plus, RefreshCw,
  Save, Trash2, Upload, ZoomIn, ZoomOut,
} from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/toast.jsx';
import { EmptyState, ErrorNote, Modal, PageHeader, StatusBadge } from '../components/ui.jsx';
import { getAtcScope, isAtc } from '../lib/pos.js';

// /floor-designer — TQ-1 owner/manager screen: Store → Floor → Dining Area →
// Table, drag/drop layout with draft → preview → publish. Geometry is layout
// data; table identity (tableId) never changes here, so QR and order links
// survive renames and moves. 409 POS_LAYOUT_CONFLICT = someone else edited the
// draft; the banner offers reload, never a blind overwrite.

const AREA_KINDS = ['INDOOR', 'OUTDOOR', 'PATIO', 'ROOFTOP', 'CUSTOM'];
const OBJECT_KINDS = ['WALL', 'ENTRANCE', 'PILLAR', 'KITCHEN', 'COUNTER'];
const OBJECT_STYLES = {
  WALL: 'bg-slate-500',
  ENTRANCE: 'bg-emerald-300',
  PILLAR: 'bg-slate-400',
  KITCHEN: 'bg-orange-200 border border-orange-400',
  COUNTER: 'bg-amber-300',
};
const AREA_TINTS = {
  INDOOR: 'bg-sky-50 text-sky-700',
  OUTDOOR: 'bg-emerald-50 text-emerald-700',
  PATIO: 'bg-lime-50 text-lime-700',
  ROOFTOP: 'bg-violet-50 text-violet-700',
  CUSTOM: 'bg-slate-100 text-slate-600',
};

const snap = (v, grid, on) => (on ? Math.round(v / grid) * grid : Math.round(v));
let tempSeq = 0;
const tempKey = () => `new-${++tempSeq}`;

function FloorForm({ floor, branches, owner, onDone }) {
  const [name, setName] = useState(floor?.name || '');
  const [branchId, setBranchId] = useState(branches?.[0]?.id || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (floor) await api.patch(`/floors/${floor.id}`, { name: name.trim() });
      else await api.post('/floors', { name: name.trim(), ...(owner ? { branchId } : {}) });
      onDone();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      {!floor && owner ? (
        <div>
          <label className="label" htmlFor="f-branch">Branch</label>
          <select id="f-branch" className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)} required>
            {(branches || []).map((b) => (
              <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
            ))}
          </select>
        </div>
      ) : null}
      <div>
        <label className="label" htmlFor="f-name">Floor name</label>
        <input id="f-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Ground Floor" autoFocus />
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy || !name.trim()}>
        {busy ? 'Saving…' : floor ? 'Save changes' : 'Create floor'}
      </button>
    </form>
  );
}

function AreaForm({ floorId, onDone }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('INDOOR');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post(`/floors/${floorId}/areas`, { name: name.trim(), kind });
      onDone();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="a-name">Area name</label>
        <input id="a-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Main Hall" autoFocus />
      </div>
      <div>
        <label className="label" htmlFor="a-kind">Type</label>
        <select id="a-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          {AREA_KINDS.map((k) => <option key={k} value={k}>{k.charAt(0) + k.slice(1).toLowerCase()}</option>)}
        </select>
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy || !name.trim()}>
        {busy ? 'Saving…' : 'Add area'}
      </button>
    </form>
  );
}

export default function FloorDesigner() {
  const { user } = useAuth();
  const toast = useToast();
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;
  const owner = user.role === 'CUSTOMER_OWNER';
  const writer = owner || user.role === 'BRANCH_MANAGER';

  const [branches, setBranches] = useState([]);
  const [floors, setFloors] = useState(null);
  const [floorId, setFloorId] = useState('');
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // 'new-floor' | 'edit-floor' | 'new-area'

  // Layout editor state
  const [mode, setMode] = useState('view'); // view (published) | edit (draft)
  const [layout, setLayout] = useState(null); // server copy (view mode / draft meta)
  const [revision, setRevision] = useState(0);
  const [tables, setTables] = useState([]); // editable placements
  const [objects, setObjects] = useState([]);
  const [gridSize, setGridSize] = useState(20);
  const [canvas, setCanvas] = useState({ w: 1200, h: 800 });
  const [background, setBackground] = useState(null);
  const [snapOn, setSnapOn] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState(null); // {type:'table'|'object', key}
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState('');
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const fileRef = useRef(null);

  const floor = (floors || []).find((f) => f.id === floorId) || null;

  const loadFloors = useCallback(async () => {
    if (atc && !atcScope) return;
    setError('');
    try {
      const { data } = await api.get('/floors');
      setFloors(data.floors || []);
      if (!floorId && data.floors?.length) setFloorId(data.floors[0].id);
    } catch (err) {
      setError(apiError(err, 'Could not load floors'));
    }
  }, [atc, atcScope, floorId]);

  useEffect(() => { loadFloors(); }, [loadFloors]);

  useEffect(() => {
    if (!owner) return;
    (async () => {
      try {
        const { data } = await api.get('/branches');
        setBranches((data.branches || []).filter((b) => b.status === 'ACTIVE'));
      } catch { /* optional */ }
    })();
  }, [owner]);

  const adoptLayout = useCallback((l) => {
    setLayout(l);
    setRevision(l?.revision ?? 0);
    setGridSize(l?.gridSize ?? 20);
    setCanvas({ w: l?.canvasWidth ?? 1200, h: l?.canvasHeight ?? 800 });
    setBackground(l?.backgroundImage ?? null);
    setTables(
      (l?.tables || []).map((t) => ({
        key: t.tableId,
        tableId: t.tableId,
        name: t.name,
        rename: null,
        occupied: t.occupied,
        areaId: t.areaId,
        shape: t.shape,
        x: t.x, y: t.y, width: t.width, height: t.height, rotation: t.rotation,
        seats: t.seats ?? t.capacity ?? null,
      })),
    );
    setObjects(
      (l?.objects || []).map((o) => ({
        key: o.id || tempKey(),
        kind: o.kind, label: o.label,
        x: o.x, y: o.y, width: o.width, height: o.height, rotation: o.rotation,
      })),
    );
    setSelected(null);
    setDirty(false);
    setConflict('');
  }, []);

  const loadLayout = useCallback(async (which) => {
    if (!floorId) return;
    try {
      const { data } = await api.get(`/floors/${floorId}/layout`, { params: which === 'edit' ? { mode: 'draft' } : {} });
      adoptLayout(data.layout);
      return data.layout;
    } catch (err) {
      setError(apiError(err, 'Could not load layout'));
      return null;
    }
  }, [floorId, adoptLayout]);

  useEffect(() => {
    setMode('view');
    loadLayout('view');
  }, [floorId]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEditing = async () => {
    setBusy(true);
    setError('');
    try {
      let draft = await loadLayout('edit');
      if (!draft) {
        const { data } = await api.post(`/floors/${floorId}/draft`, {});
        draft = data.layout;
        adoptLayout(draft);
      }
      setMode('edit');
    } catch (err) {
      if (err?.response?.data?.error?.code === 'POS_DRAFT_EXISTS') {
        await loadLayout('edit');
        setMode('edit');
      } else setError(apiError(err, 'Could not open a draft'));
    } finally {
      setBusy(false);
    }
  };

  const payload = () => ({
    revision,
    gridSize,
    canvasWidth: canvas.w,
    canvasHeight: canvas.h,
    backgroundImage: background,
    tables: tables.map((t) => ({
      ...(t.tableId ? { tableId: t.tableId } : { create: { name: t.name, capacity: t.seats ?? undefined } }),
      ...(t.tableId && t.rename && t.rename !== t.name ? { rename: t.rename } : {}),
      areaId: t.areaId || null,
      shape: t.shape,
      seats: t.seats ?? null,
      x: t.x, y: t.y, width: t.width, height: t.height, rotation: t.rotation,
    })),
    objects: objects.map((o) => ({
      kind: o.kind, label: o.label || null,
      x: o.x, y: o.y, width: o.width, height: o.height, rotation: o.rotation,
    })),
  });

  const saveDraft = async ({ silent } = {}) => {
    setBusy(true);
    setError('');
    setConflict('');
    try {
      const { data } = await api.put(`/floors/${floorId}/draft`, payload());
      adoptLayout(data.layout);
      if (!silent) toast('Draft saved', 'success');
      return data.layout;
    } catch (err) {
      const code = err?.response?.data?.error?.code;
      if (code === 'POS_LAYOUT_CONFLICT') setConflict(apiError(err));
      else setError(apiError(err, 'Could not save the draft'));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    const saved = await saveDraft({ silent: true });
    if (!saved) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/floors/${floorId}/draft/publish`, { revision: saved.revision });
      toast(`Published version ${data.layout.version}`, 'success');
      setMode('view');
      adoptLayout(data.layout);
      loadFloors();
    } catch (err) {
      const code = err?.response?.data?.error?.code;
      if (code === 'POS_LAYOUT_CONFLICT') setConflict(apiError(err));
      else setError(apiError(err, 'Could not publish'));
    } finally {
      setBusy(false);
    }
  };

  const discardDraft = async () => {
    setBusy(true);
    try {
      await api.delete(`/floors/${floorId}/draft`);
      toast('Draft discarded', 'info');
      setMode('view');
      await loadLayout('view');
    } catch (err) {
      setError(apiError(err, 'Could not discard the draft'));
    } finally {
      setBusy(false);
    }
  };

  // ---- canvas interactions ----
  const onPointerDown = (e, type, key) => {
    if (mode !== 'edit') return;
    e.stopPropagation();
    setSelected({ type, key });
    const list = type === 'table' ? tables : objects;
    const item = list.find((i) => i.key === key);
    dragRef.current = {
      type, key,
      startX: e.clientX, startY: e.clientY,
      origX: item.x, origY: item.y,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / zoom;
    const dy = (e.clientY - d.startY) / zoom;
    const apply = (list, setList) =>
      setList(list.map((i) => (i.key === d.key
        ? { ...i, x: snap(d.origX + dx, gridSize, snapOn), y: snap(d.origY + dy, gridSize, snapOn) }
        : i)));
    if (d.type === 'table') apply(tables, setTables);
    else apply(objects, setObjects);
    setDirty(true);
  };

  const onPointerUp = () => { dragRef.current = null; };

  const addTable = (shape) => {
    const n = tables.length + 1;
    const size = shape === 'RECT' ? { width: 120, height: 60 } : { width: 80, height: 80 };
    const t = {
      key: tempKey(), tableId: null, name: `T${n}`, rename: null, occupied: false,
      areaId: floor?.areas?.[0]?.id ?? null, shape, seats: shape === 'RECT' ? 6 : 4,
      x: snap(80 + (n % 6) * 60, gridSize, snapOn), y: snap(80 + (n % 4) * 60, gridSize, snapOn),
      rotation: 0, ...size,
    };
    setTables([...tables, t]);
    setSelected({ type: 'table', key: t.key });
    setDirty(true);
  };

  const addObject = (kind) => {
    const preset = kind === 'WALL' ? { width: 200, height: 12 }
      : kind === 'PILLAR' ? { width: 30, height: 30 }
      : kind === 'ENTRANCE' ? { width: 80, height: 14 }
      : { width: 140, height: 90 };
    const o = { key: tempKey(), kind, label: kind === 'KITCHEN' ? 'Kitchen' : kind === 'COUNTER' ? 'Counter' : null, x: 60, y: 60, rotation: 0, ...preset };
    setObjects([...objects, o]);
    setSelected({ type: 'object', key: o.key });
    setDirty(true);
  };

  const updateSelected = (patch) => {
    if (!selected) return;
    const apply = (list, setList) => setList(list.map((i) => (i.key === selected.key ? { ...i, ...patch } : i)));
    if (selected.type === 'table') apply(tables, setTables);
    else apply(objects, setObjects);
    setDirty(true);
  };

  const removeSelected = () => {
    if (!selected) return;
    if (selected.type === 'table') {
      const t = tables.find((i) => i.key === selected.key);
      if (t?.occupied) {
        setError('That table has an open order; settle it before removing it from the plan.');
        return;
      }
      setTables(tables.filter((i) => i.key !== selected.key));
    } else {
      setObjects(objects.filter((i) => i.key !== selected.key));
    }
    setSelected(null);
    setDirty(true);
  };

  const onBackgroundFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Background must be an image'); return; }
    if (file.size > 450 * 1024) { setError('Background image must be under 450 KB'); return; }
    const reader = new FileReader();
    reader.onload = () => { setBackground(reader.result); setDirty(true); };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const selectedItem = selected
    ? (selected.type === 'table' ? tables : objects).find((i) => i.key === selected.key)
    : null;

  const editing = mode === 'edit';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Floor designer"
        subtitle="Floors, dining areas and table layout — draft, preview, publish"
        actions={
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary" onClick={() => { loadFloors(); loadLayout(editing ? 'edit' : 'view'); }}>
              <RefreshCw size={16} /> Refresh
            </button>
            {writer ? (
              <button type="button" className="btn-primary" onClick={() => setModal('new-floor')}>
                <Plus size={16} /> New floor
              </button>
            ) : null}
          </div>
        }
      />

      {atc && !atcScope ? (
        <EmptyState icon={Layers} title="Pick a company first" note="Choose a company in the ATC console to view its floors." />
      ) : null}

      <ErrorNote message={error} />
      {conflict ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex items-center justify-between gap-3">
          <span><strong>Concurrent edit:</strong> {conflict}</span>
          <button
            type="button"
            className="btn-secondary"
            onClick={async () => { await loadLayout('edit'); toast('Draft reloaded', 'info'); }}
          >
            Reload draft
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <select className="input max-w-xs" value={floorId} onChange={(e) => setFloorId(e.target.value)} aria-label="Floor">
          {(floors || []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} {f.publishedVersion ? `(v${f.publishedVersion})` : '(unpublished)'}
            </option>
          ))}
        </select>
        {floor && writer ? (
          <>
            <button type="button" className="btn-secondary" onClick={() => setModal('edit-floor')}><Pencil size={16} /> Rename</button>
            <button type="button" className="btn-secondary" onClick={() => setModal('new-area')}><Plus size={16} /> Area</button>
          </>
        ) : null}
        {floor?.areas?.map((a) => (
          <span key={a.id} className={`rounded-full px-2.5 py-1 text-xs font-medium ${AREA_TINTS[a.kind] || AREA_TINTS.CUSTOM}`}>
            {a.name} · {a.kind.toLowerCase()}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-2">
          {floor?.hasDraft && !editing ? <StatusBadge status="DRAFT" /> : null}
          {editing ? (
            <>
              <button type="button" className="btn-secondary" onClick={discardDraft} disabled={busy}><Trash2 size={16} /> Discard</button>
              <button type="button" className="btn-secondary" onClick={() => saveDraft()} disabled={busy}><Save size={16} /> Save draft</button>
              <button type="button" className="btn-primary" onClick={publish} disabled={busy}><Check size={16} /> Publish</button>
            </>
          ) : writer && floor ? (
            <button type="button" className="btn-primary" onClick={startEditing} disabled={busy}>
              <Pencil size={16} /> {floor.hasDraft ? 'Continue draft' : 'Edit layout'}
            </button>
          ) : null}
        </span>
      </div>

      {floors && !floors.length ? (
        <EmptyState icon={Layers} title="No floors yet" note={writer ? 'Create your first floor to start placing tables.' : 'Ask an owner or manager to set up floors.'} />
      ) : null}

      {floor ? (
        <div className="flex gap-4">
          <div className="flex-1 overflow-auto rounded-xl border border-slate-200 bg-white p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              {editing ? (
                <>
                  <span className="font-medium text-slate-600">Add:</span>
                  <button type="button" className="btn-secondary" onClick={() => addTable('ROUND')}><Armchair size={14} /> Round</button>
                  <button type="button" className="btn-secondary" onClick={() => addTable('SQUARE')}><Armchair size={14} /> Square</button>
                  <button type="button" className="btn-secondary" onClick={() => addTable('RECT')}><Armchair size={14} /> Rect</button>
                  {OBJECT_KINDS.map((k) => (
                    <button key={k} type="button" className="btn-secondary" onClick={() => addObject(k)}>{k.charAt(0) + k.slice(1).toLowerCase()}</button>
                  ))}
                  <label className="btn-secondary cursor-pointer">
                    <Upload size={14} /> Background
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onBackgroundFile} />
                  </label>
                  {background ? (
                    <button type="button" className="btn-secondary" onClick={() => { setBackground(null); setDirty(true); }}>
                      <ImageIcon size={14} /> Clear bg
                    </button>
                  ) : null}
                  <label className="flex items-center gap-1.5 text-slate-600">
                    <input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} /> Snap {gridSize}px
                  </label>
                </>
              ) : (
                <span className="flex items-center gap-1.5 text-slate-500">
                  <Eye size={14} /> {layout ? `Published v${layout.version}` : 'Nothing published yet'} — read-only preview
                </span>
              )}
              <span className="ml-auto flex items-center gap-1">
                <button type="button" className="btn-secondary" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.2).toFixed(2)))} aria-label="Zoom out"><ZoomOut size={14} /></button>
                <span className="w-12 text-center text-slate-500">{Math.round(zoom * 100)}%</span>
                <button type="button" className="btn-secondary" onClick={() => setZoom((z) => Math.min(2.4, +(z + 0.2).toFixed(2)))} aria-label="Zoom in"><ZoomIn size={14} /></button>
              </span>
            </div>

            <div className="overflow-auto" style={{ maxHeight: '70vh' }}>
              <div
                ref={canvasRef}
                role="application"
                aria-label="Floor canvas"
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerDown={() => setSelected(null)}
                className="relative rounded-lg border border-slate-300"
                style={{
                  width: canvas.w * zoom,
                  height: canvas.h * zoom,
                  backgroundColor: '#fafaf9',
                  backgroundImage: background
                    ? `url(${background})`
                    : `linear-gradient(to right, #eee 1px, transparent 1px), linear-gradient(to bottom, #eee 1px, transparent 1px)`,
                  backgroundSize: background ? '100% 100%' : `${gridSize * zoom}px ${gridSize * zoom}px`,
                }}
              >
                {objects.map((o) => (
                  <div
                    key={o.key}
                    onPointerDown={(e) => onPointerDown(e, 'object', o.key)}
                    className={`absolute flex items-center justify-center text-[10px] font-medium text-slate-700 ${OBJECT_STYLES[o.kind]} ${editing ? 'cursor-move' : ''} ${selected?.key === o.key ? 'ring-2 ring-blue-500' : ''}`}
                    style={{
                      left: o.x * zoom, top: o.y * zoom,
                      width: o.width * zoom, height: o.height * zoom,
                      transform: `rotate(${o.rotation}deg)`,
                    }}
                    title={o.label || o.kind}
                  >
                    {o.label || (o.kind !== 'WALL' && o.kind !== 'PILLAR' ? o.kind : '')}
                  </div>
                ))}
                {tables.map((t) => (
                  <div
                    key={t.key}
                    onPointerDown={(e) => onPointerDown(e, 'table', t.key)}
                    className={`absolute flex flex-col items-center justify-center border-2 text-xs font-semibold shadow-sm ${t.occupied ? 'border-rose-400 bg-rose-50 text-rose-700' : 'border-slate-400 bg-white text-slate-700'} ${editing ? 'cursor-move' : ''} ${selected?.key === t.key ? 'ring-2 ring-blue-500' : ''}`}
                    style={{
                      left: t.x * zoom, top: t.y * zoom,
                      width: t.width * zoom, height: t.height * zoom,
                      borderRadius: t.shape === 'ROUND' ? '9999px' : '8px',
                      transform: `rotate(${t.rotation}deg)`,
                    }}
                    title={`${t.rename || t.name}${t.occupied ? ' (occupied)' : ''}`}
                  >
                    <span>{t.rename || t.name}</span>
                    {t.seats ? <span className="text-[10px] font-normal text-slate-500">{t.seats} seats</span> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {editing && selectedItem ? (
            <div className="w-64 shrink-0 space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-700">
                  {selected.type === 'table' ? (selectedItem.rename || selectedItem.name) : selectedItem.kind}
                </h3>
                <button type="button" className="text-rose-600 hover:text-rose-700" onClick={removeSelected} aria-label="Remove"><Trash2 size={16} /></button>
              </div>
              {selected.type === 'table' ? (
                <>
                  <div>
                    <label className="label" htmlFor="p-name">Name</label>
                    <input
                      id="p-name" className="input"
                      value={selectedItem.rename ?? selectedItem.name}
                      disabled={selectedItem.occupied}
                      onChange={(e) => updateSelected(selectedItem.tableId ? { rename: e.target.value } : { name: e.target.value })}
                    />
                    {selectedItem.occupied ? <p className="mt-1 text-xs text-slate-500">Occupied — settle the order to rename.</p> : null}
                  </div>
                  <div>
                    <label className="label" htmlFor="p-area">Area</label>
                    <select id="p-area" className="input" value={selectedItem.areaId || ''} onChange={(e) => updateSelected({ areaId: e.target.value || null })}>
                      <option value="">No area</option>
                      {floor.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="p-shape">Shape</label>
                    <select id="p-shape" className="input" value={selectedItem.shape} onChange={(e) => updateSelected({ shape: e.target.value })}>
                      <option value="ROUND">Round</option>
                      <option value="SQUARE">Square</option>
                      <option value="RECT">Rectangular</option>
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="p-seats">Seats</label>
                    <input id="p-seats" type="number" min="1" max="99" className="input" value={selectedItem.seats ?? ''} onChange={(e) => updateSelected({ seats: e.target.value === '' ? null : Number(e.target.value) })} />
                  </div>
                </>
              ) : (
                <div>
                  <label className="label" htmlFor="p-label">Label</label>
                  <input id="p-label" className="input" value={selectedItem.label || ''} onChange={(e) => updateSelected({ label: e.target.value })} />
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label" htmlFor="p-w">Width</label>
                  <input id="p-w" type="number" min="10" max="2000" className="input" value={selectedItem.width} onChange={(e) => updateSelected({ width: Number(e.target.value) || 10 })} />
                </div>
                <div>
                  <label className="label" htmlFor="p-h">Height</label>
                  <input id="p-h" type="number" min="10" max="2000" className="input" value={selectedItem.height} onChange={(e) => updateSelected({ height: Number(e.target.value) || 10 })} />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="p-rot">Rotation ({selectedItem.rotation}°)</label>
                <input id="p-rot" type="range" min="0" max="359" step="5" className="w-full" value={selectedItem.rotation} onChange={(e) => updateSelected({ rotation: Number(e.target.value) })} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {dirty && editing ? (
        <p className="text-xs text-slate-500">Unsaved changes — Save draft keeps them; Publish makes them live for service screens.</p>
      ) : null}

      <Modal open={modal === 'new-floor'} onClose={() => setModal(null)} title="New floor">
        <FloorForm branches={branches} owner={owner} onDone={() => { setModal(null); loadFloors(); }} />
      </Modal>
      <Modal open={modal === 'edit-floor'} onClose={() => setModal(null)} title="Rename floor">
        {floor ? <FloorForm floor={floor} branches={branches} owner={owner} onDone={() => { setModal(null); loadFloors(); }} /> : null}
      </Modal>
      <Modal open={modal === 'new-area'} onClose={() => setModal(null)} title="Add dining area">
        {floor ? <AreaForm floorId={floor.id} onDone={() => { setModal(null); loadFloors(); }} /> : null}
      </Modal>
    </div>
  );
}
