// @vitest-environment jsdom
// 0.18.0: an admin phone looks after the server's phones (ServerPhones.tsx, lib/serverPhones.ts):
// the list with Admin on the admins, Make admin / Make user, Remove (not itself), and Add a phone
// or tablet, each one request through RestockNative.serverAdmin.
import { createElement } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const calls = vi.hoisted(() => ({ list: [] as { method: string; path: string; body?: unknown }[], confirm: true }));
const PHONES = [
  { device: 'd-me', label: 'Declan', role: 'admin', me: true, status: 'active' },
  { device: 'd-sarah', label: "Sarah's phone", role: 'user', status: 'active' },
  { device: 'd-ipad', label: 'Kitchen iPad', role: 'admin', status: 'active' },
  { device: 'd-old', label: 'Old phone', status: 'removed' },
];
vi.mock('../../lib/sql/native', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/sql/native')>();
  return {
    ...real,
    RestockNative: {
      serverAdmin: async (o: { method: string; path: string; body?: unknown }) => {
        calls.list.push(o);
        if (o.method === 'GET' && o.path === '/phones') return { phones: PHONES };
        if (o.method === 'POST') return { code: 'restock-server:3?h=x&i=y&k=z', expiresIn: 600, role: (o.body as { admin?: boolean }).admin ? 'admin' : 'user' };
        return { ok: true };
      },
      syncNow: async () => ({}),
    },
  };
});
vi.mock('../../lib/confirm', () => ({ confirmAction: async () => calls.confirm }));
vi.mock('./SyncCodes', () => ({ PairingQr: ({ code }: { code: string }) => createElement('div', { 'data-code': code }), CodeText: () => null }));
vi.mock('../components', async (importOriginal) => {
  const real = await importOriginal<typeof import('../components')>();
  return { ...real, Sheet: ({ title, children }: { title: string; children: unknown }) => createElement('section', { 'aria-label': title }, createElement('h2', null, title), children as never) };
});

const { ServerPhones } = await import('./ServerPhones');
const { newCode, myRole } = await import('../../lib/serverPhones');
const { NavContext } = await import('../nav');
const toasts: string[] = [];
const nav = { toast: (m: string) => toasts.push(m), pop: () => undefined, push: () => undefined } as never;
const show = () => render(createElement(NavContext.Provider, { value: nav }, createElement(ServerPhones, { label: 'Home' })));

beforeEach(() => {
  cleanup();
  calls.list = [];
  calls.confirm = true;
  toasts.length = 0;
});

describe('Phones and tablets, on an admin phone', () => {
  it('lists the active phones, this one first, with Admin on the admins (removed ones left out)', async () => {
    show();
    await screen.findByText("Sarah's phone");
    const rows = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(rows[0]).toMatch(/^Declan \(this phone\)Admin/);
    expect(rows.find((r) => r.startsWith('Kitchen iPad'))).toContain('Admin');
    expect(rows.find((r) => r.startsWith("Sarah's phone"))).not.toContain('Admin');
    expect(screen.queryByText('Old phone')).toBeNull();
  });

  it('Make admin and Remove go to the server; this phone has no Remove', async () => {
    show();
    fireEvent.click(await screen.findByText("Sarah's phone"));
    fireEvent.click(screen.getByText('Make admin'));
    await waitFor(() => expect(calls.list.some((c) => c.method === 'PATCH' && c.path === '/phones/d-sarah' && (c.body as { role?: string }).role === 'admin')).toBe(true));
    fireEvent.click(await screen.findByText("Sarah's phone"));
    fireEvent.click(screen.getByText("Remove Sarah's phone"));
    await waitFor(() => expect(calls.list.some((c) => c.method === 'DELETE' && c.path === '/phones/d-sarah')).toBe(true));
    // Said no: nothing sent.
    calls.list = [];
    calls.confirm = false;
    fireEvent.click(await screen.findByText('Kitchen iPad'));
    fireEvent.click(screen.getByText('Remove Kitchen iPad'));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.list.some((c) => c.method === 'DELETE')).toBe(false);
    cleanup();
    show();
    fireEvent.click(await screen.findByText(/Declan/));
    expect(screen.queryByText(/^Remove /)).toBeNull();
  });

  it('Add a phone or tablet: a code for a user, or with Make admin an admin', async () => {
    show();
    fireEvent.click(await screen.findByText('Add a phone or tablet'));
    fireEvent.change(screen.getByLabelText('Whose phone or tablet is it?'), { target: { value: "Mum's iPad" } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('Show the code'));
    await screen.findByText(/joins as an admin/);
    expect(calls.list.find((c) => c.method === 'POST')?.body).toEqual({ label: "Mum's iPad", admin: true });
    expect(document.querySelector('[data-code]')?.getAttribute('data-code')).toBe('restock-server:3?h=x&i=y&k=z');
  });

  it('a code that isn’t a server code is refused; a server without roles answers null', async () => {
    await expect(newCode('X', false)).resolves.toMatchObject({ code: 'restock-server:3?h=x&i=y&k=z' });
    expect(await myRole()).toBe('user');
  });
});
