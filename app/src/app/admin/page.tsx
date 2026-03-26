'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import toast from 'react-hot-toast';
import { usePerk } from '@/providers/PerkProvider';
import {
  ProtocolAccount,
  MarketAccount,
  OracleSource,
  SetFallbackOracleParams,
  UpdateOracleConfigParams,
  AdminUpdateMarketParams,
  PerkOracleAccount,
} from '@perk/sdk';

// ── Constants ──

const ADMIN_PUBKEY = 'CxtsPjsmDFnjxtX25UWznyB8mgzAsHdFueGspcUM69LX';
const LAMPORTS_PER_SOL = 1_000_000_000;

// ── Helpers ──

function truncatePubkey(key: string): string {
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function lamportsToSol(lamports: BN): string {
  const num = Number(lamports.toString()) / LAMPORTS_PER_SOL;
  return num.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 9 });
}

function oracleSourceLabel(source: OracleSource): string {
  switch (source) {
    case OracleSource.Pyth: return 'Pyth';
    case OracleSource.PerkOracle: return 'PerkOracle';
    case OracleSource.DexPool: return 'DexPool';
    default: return `Unknown(${source})`;
  }
}

// ── Types ──

interface MarketWithAddress {
  address: PublicKey;
  account: MarketAccount;
}

// ── Main Page ──

export default function AdminPage() {
  const { publicKey, connected } = useWallet();
  const { client, readonlyClient } = usePerk();

  const isAdmin = connected && publicKey?.toBase58() === ADMIN_PUBKEY;

  if (!connected) {
    return <ConnectWalletScreen />;
  }

  if (!isAdmin) {
    return <UnauthorizedScreen address={publicKey?.toBase58() ?? ''} />;
  }

  return <AdminDashboard client={client} readonlyClient={readonlyClient} />;
}

// ── Screens ──

function ConnectWalletScreen() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="border border-border rounded-[2px] bg-surface p-8 max-w-sm w-full text-center space-y-6">
        <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
          PERK ADMIN
        </div>
        <h1 className="font-sans font-semibold text-xl text-white">
          Connect Wallet
        </h1>
        <p className="text-sm text-text-secondary font-sans">
          Admin access requires the protocol admin wallet.
        </p>
        <div className="flex justify-center">
          <WalletMultiButton />
        </div>
      </div>
    </div>
  );
}

function UnauthorizedScreen({ address }: { address: string }) {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="border border-border rounded-[2px] bg-surface p-8 max-w-sm w-full text-center space-y-4">
        <div className="font-mono text-sm text-loss">UNAUTHORIZED</div>
        <p className="text-sm text-text-secondary font-sans">
          Connected: <span className="font-mono text-white">{truncatePubkey(address)}</span>
        </p>
        <p className="text-xs text-text-tertiary font-sans">
          Expected: <span className="font-mono">{truncatePubkey(ADMIN_PUBKEY)}</span>
        </p>
        <div className="flex justify-center pt-2">
          <WalletMultiButton />
        </div>
      </div>
    </div>
  );
}

// ── Dashboard ──

function AdminDashboard({
  client,
  readonlyClient,
}: {
  client: ReturnType<typeof usePerk>['client'];
  readonlyClient: ReturnType<typeof usePerk>['readonlyClient'];
}) {
  const [protocol, setProtocol] = useState<ProtocolAccount | null>(null);
  const [markets, setMarkets] = useState<MarketWithAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMarket, setSelectedMarket] = useState<MarketWithAddress | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [proto, mkts] = await Promise.all([
        readonlyClient.fetchProtocol(),
        readonlyClient.fetchAllMarkets(),
      ]);
      setProtocol(proto);
      setMarkets(mkts);
    } catch (err) {
      console.error('Failed to fetch protocol data:', err);
      toast.error('Failed to fetch protocol data');
    } finally {
      setLoading(false);
    }
  }, [readonlyClient]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="font-mono text-sm text-text-secondary animate-pulse">
          Loading protocol state...
        </div>
      </div>
    );
  }

  const protocolAddress = readonlyClient.getProtocolAddress().toBase58();

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <div className="border-b border-border px-4 md:px-8 h-14 flex items-center justify-between max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
            PERK ADMIN
          </div>
          <div className="w-px h-4 bg-border" />
          <div className="font-mono text-xs text-profit">● CONNECTED</div>
        </div>
        <WalletMultiButton />
      </div>

      <div className="max-w-7xl mx-auto px-4 md:px-8 py-6 space-y-6">
        {/* Section 1: Protocol Overview */}
        {protocol && (
          <ProtocolOverview
            protocol={protocol}
            protocolAddress={protocolAddress}
            marketCount={markets.length}
          />
        )}

        {/* Section 2: Protocol Actions */}
        {protocol && client && (
          <ProtocolActions
            client={client}
            protocol={protocol}
            onRefresh={fetchData}
          />
        )}

        {/* Section 3: Markets Table */}
        <MarketsTable
          markets={markets}
          selectedMarket={selectedMarket}
          onSelectMarket={setSelectedMarket}
        />

        {/* Section 4: Market Edit Panel */}
        {selectedMarket && client && (
          <MarketEditPanel
            client={client}
            market={selectedMarket}
            onRefresh={fetchData}
            onClose={() => setSelectedMarket(null)}
          />
        )}
      </div>
    </div>
  );
}

// ── Section 1: Protocol Overview ──

function ProtocolOverview({
  protocol,
  protocolAddress,
  marketCount,
}: {
  protocol: ProtocolAccount;
  protocolAddress: string;
  marketCount: number;
}) {
  return (
    <section className="border border-border rounded-[2px] bg-surface">
      <div className="px-5 py-3 border-b border-border">
        <span className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
          Protocol Overview
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-px bg-border">
        <InfoCell
          label="Protocol PDA"
          value={truncatePubkey(protocolAddress)}
          mono
          copyValue={protocolAddress}
        />
        <InfoCell
          label="Admin"
          value={truncatePubkey(protocol.admin.toBase58())}
          mono
          copyValue={protocol.admin.toBase58()}
        />
        <InfoCell
          label="Status"
          value={protocol.paused ? 'PAUSED' : 'ACTIVE'}
          color={protocol.paused ? 'text-loss' : 'text-profit'}
        />
        <InfoCell label="Markets" value={marketCount.toString()} />
        <InfoCell
          label="Total Fees"
          value={`${lamportsToSol(protocol.totalFeesCollected)} SOL`}
          mono
        />
      </div>
    </section>
  );
}

function InfoCell({
  label,
  value,
  mono,
  color,
  copyValue,
}: {
  label: string;
  value: string;
  mono?: boolean;
  color?: string;
  copyValue?: string;
}) {
  const handleCopy = () => {
    if (copyValue) {
      navigator.clipboard.writeText(copyValue);
      toast.success('Copied to clipboard');
    }
  };

  return (
    <div className="bg-surface px-5 py-4">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider mb-1">
        {label}
      </div>
      <div
        className={`text-sm ${mono ? 'font-mono' : 'font-sans font-medium'} ${color ?? 'text-white'} ${copyValue ? 'cursor-pointer hover:text-text-secondary transition-colors' : ''}`}
        onClick={copyValue ? handleCopy : undefined}
        title={copyValue ? `Click to copy: ${copyValue}` : undefined}
      >
        {value}
      </div>
    </div>
  );
}

// ── Section 2: Protocol Actions ──

function ProtocolActions({
  client,
  protocol,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  protocol: ProtocolAccount;
  onRefresh: () => Promise<void>;
}) {
  return (
    <section className="border border-border rounded-[2px] bg-surface">
      <div className="px-5 py-3 border-b border-border">
        <span className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
          Protocol Actions
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border">
        <PauseToggle client={client} paused={protocol.paused} onRefresh={onRefresh} />
        <WithdrawSol client={client} onRefresh={onRefresh} />
        <TransferAdmin client={client} onRefresh={onRefresh} />
      </div>
    </section>
  );
}

function PauseToggle({
  client,
  paused,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  paused: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);

  const handleToggle = async () => {
    setSubmitting(true);
    try {
      const sig = await client.adminPause(!paused);
      toast.success(`Protocol ${paused ? 'unpaused' : 'paused'} — ${truncatePubkey(sig)}`);
      await onRefresh();
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Pause / Unpause
      </div>
      <p className="text-xs text-text-secondary font-sans">
        Currently: <span className={paused ? 'text-loss' : 'text-profit'}>{paused ? 'PAUSED' : 'ACTIVE'}</span>
      </p>
      <button
        onClick={handleToggle}
        disabled={submitting}
        className={`font-mono text-xs px-4 py-2 rounded-[2px] border transition-colors disabled:opacity-50 ${
          paused
            ? 'border-profit/30 text-profit hover:bg-profit/10'
            : 'border-loss/30 text-loss hover:bg-loss/10'
        }`}
      >
        {submitting ? 'Submitting...' : paused ? 'Unpause Protocol' : 'Pause Protocol'}
      </button>
    </div>
  );
}

function WithdrawSol({
  client,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  onRefresh: () => Promise<void>;
}) {
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleWithdraw = async () => {
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      toast.error('Enter a valid SOL amount');
      return;
    }
    setSubmitting(true);
    try {
      const lamports = new BN(Math.floor(parsed * LAMPORTS_PER_SOL));
      const sig = await client.adminWithdrawSol(lamports);
      toast.success(`Withdrew ${parsed} SOL — ${truncatePubkey(sig)}`);
      setAmount('');
      await onRefresh();
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Withdraw SOL
      </div>
      <div className="flex gap-2">
        <input
          type="number"
          step="0.001"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className="flex-1 bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-sm text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <button
          onClick={handleWithdraw}
          disabled={submitting || !amount}
          className="font-mono text-xs px-4 py-2 rounded-[2px] border border-border text-white hover:bg-white/5 transition-colors disabled:opacity-50"
        >
          {submitting ? '...' : 'Withdraw'}
        </button>
      </div>
    </div>
  );
}

function TransferAdmin({
  client,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  onRefresh: () => Promise<void>;
}) {
  const [newAdmin, setNewAdmin] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleTransfer = async () => {
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(newAdmin);
    } catch {
      toast.error('Invalid public key');
      return;
    }
    setSubmitting(true);
    try {
      const sig = await client.proposeAdmin(pubkey);
      toast.success(`Proposed new admin — ${truncatePubkey(sig)}`);
      setNewAdmin('');
      await onRefresh();
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Transfer Admin
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={newAdmin}
          onChange={(e) => setNewAdmin(e.target.value)}
          placeholder="New admin pubkey"
          className="flex-1 bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-sm text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <button
          onClick={handleTransfer}
          disabled={submitting || !newAdmin}
          className="font-mono text-xs px-4 py-2 rounded-[2px] border border-loss/30 text-loss hover:bg-loss/10 transition-colors disabled:opacity-50"
        >
          {submitting ? '...' : 'Propose'}
        </button>
      </div>
      <p className="text-xs text-text-tertiary font-sans">
        Two-step: propose here, then new admin calls acceptAdmin.
      </p>
    </div>
  );
}

// ── Section 3: Markets Table ──

function MarketsTable({
  markets,
  selectedMarket,
  onSelectMarket,
}: {
  markets: MarketWithAddress[];
  selectedMarket: MarketWithAddress | null;
  onSelectMarket: (m: MarketWithAddress | null) => void;
}) {
  return (
    <section className="border border-border rounded-[2px] bg-surface">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <span className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
          Markets ({markets.length})
        </span>
      </div>
      {markets.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-text-secondary font-sans">
          No markets found
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Mint</Th>
                <Th>Active</Th>
                <Th>Oracle</Th>
                <Th align="right">Max Lev</Th>
                <Th align="right">Fee (bps)</Th>
                <Th align="right">K</Th>
                <Th align="right" />
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => {
                const isSelected = selectedMarket?.address.equals(m.address);
                return (
                  <tr
                    key={m.address.toBase58()}
                    className={`border-b border-border/50 transition-colors cursor-pointer ${
                      isSelected ? 'bg-white/[0.04]' : 'hover:bg-white/[0.02]'
                    }`}
                    onClick={() => onSelectMarket(isSelected ? null : m)}
                  >
                    <Td mono>{truncatePubkey(m.account.tokenMint.toBase58())}</Td>
                    <Td>
                      <span className={m.account.active ? 'text-profit' : 'text-loss'}>
                        {m.account.active ? 'YES' : 'NO'}
                      </span>
                    </Td>
                    <Td>{oracleSourceLabel(m.account.oracleSource)}</Td>
                    <Td align="right" mono>{m.account.maxLeverage}x</Td>
                    <Td align="right" mono>{m.account.tradingFeeBps}</Td>
                    <Td align="right" mono>{m.account.k.toString().slice(0, 8)}...</Td>
                    <Td align="right">
                      <button
                        className="font-mono text-xs text-text-secondary hover:text-white transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectMarket(isSelected ? null : m);
                        }}
                      >
                        {isSelected ? 'Close' : 'Edit'}
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Th({ children, align }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`px-5 py-2.5 text-xs font-mono uppercase text-text-tertiary tracking-wider ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  mono,
  align,
}: {
  children?: React.ReactNode;
  mono?: boolean;
  align?: 'left' | 'right';
}) {
  return (
    <td
      className={`px-5 py-3 text-sm ${mono ? 'font-mono' : 'font-sans'} text-white ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </td>
  );
}

// ── Section 4: Market Edit Panel ──

function MarketEditPanel({
  client,
  market,
  onRefresh,
  onClose,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const m = market.account;
  const mintStr = m.tokenMint.toBase58();

  return (
    <section className="border border-border rounded-[2px] bg-surface">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
            Edit Market
          </span>
          <span className="font-mono text-xs text-white">{truncatePubkey(mintStr)}</span>
        </div>
        <button
          onClick={onClose}
          className="font-mono text-xs text-text-secondary hover:text-white transition-colors"
        >
          ✕ Close
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-border">
        <ToggleActive client={client} market={market} onRefresh={onRefresh} />
        <UpdateFee client={client} market={market} onRefresh={onRefresh} />
        <UpdateMaxLeverage client={client} market={market} onRefresh={onRefresh} />
        <UpdateOracleConfigPanel client={client} market={market} onRefresh={onRefresh} />
        <FreezePerkOracle client={client} market={market} onRefresh={onRefresh} />
        <SetFallbackOraclePanel client={client} market={market} onRefresh={onRefresh} />
      </div>
    </section>
  );
}

function ToggleActive({
  client,
  market,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const active = market.account.active;

  const handleToggle = async () => {
    setSubmitting(true);
    try {
      const params: AdminUpdateMarketParams = {
        oracleAddress: null,
        active: !active,
        tradingFeeBps: null,
        maxLeverage: null,
      };
      const sig = await client.adminUpdateMarket(market.account.tokenMint, null, params);
      toast.success(`Market ${active ? 'deactivated' : 'activated'} — ${truncatePubkey(sig)}`);
      await onRefresh();
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Toggle Active
      </div>
      <p className="text-xs text-text-secondary font-sans">
        Currently: <span className={active ? 'text-profit' : 'text-loss'}>{active ? 'ACTIVE' : 'INACTIVE'}</span>
      </p>
      <button
        onClick={handleToggle}
        disabled={submitting}
        className={`font-mono text-xs px-4 py-2 rounded-[2px] border transition-colors disabled:opacity-50 ${
          active
            ? 'border-loss/30 text-loss hover:bg-loss/10'
            : 'border-profit/30 text-profit hover:bg-profit/10'
        }`}
      >
        {submitting ? 'Submitting...' : active ? 'Deactivate' : 'Activate'}
      </button>
    </div>
  );
}

function UpdateFee({
  client,
  market,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
}) {
  const [feeBps, setFeeBps] = useState(market.account.tradingFeeBps.toString());
  const [submitting, setSubmitting] = useState(false);

  const handleUpdate = async () => {
    const parsed = parseInt(feeBps, 10);
    if (isNaN(parsed) || parsed < 0 || parsed > 65535) {
      toast.error('Fee must be 0–65535 bps');
      return;
    }
    setSubmitting(true);
    try {
      const params: AdminUpdateMarketParams = {
        oracleAddress: null,
        active: null,
        tradingFeeBps: parsed,
        maxLeverage: null,
      };
      const sig = await client.adminUpdateMarket(market.account.tokenMint, null, params);
      toast.success(`Fee updated to ${parsed} bps — ${truncatePubkey(sig)}`);
      await onRefresh();
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Trading Fee
      </div>
      <div className="flex gap-2">
        <input
          type="number"
          value={feeBps}
          onChange={(e) => setFeeBps(e.target.value)}
          placeholder="bps"
          className="flex-1 bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-sm text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <button
          onClick={handleUpdate}
          disabled={submitting}
          className="font-mono text-xs px-4 py-2 rounded-[2px] border border-border text-white hover:bg-white/5 transition-colors disabled:opacity-50"
        >
          {submitting ? '...' : 'Set'}
        </button>
      </div>
      <p className="text-xs text-text-tertiary font-sans">
        Current: {market.account.tradingFeeBps} bps ({(market.account.tradingFeeBps / 100).toFixed(2)}%)
      </p>
    </div>
  );
}

function UpdateMaxLeverage({
  client,
  market,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
}) {
  const [leverage, setLeverage] = useState(market.account.maxLeverage.toString());
  const [submitting, setSubmitting] = useState(false);

  const handleUpdate = async () => {
    const parsed = parseInt(leverage, 10);
    if (isNaN(parsed) || parsed < 1) {
      toast.error('Enter a valid max leverage');
      return;
    }
    setSubmitting(true);
    try {
      const params: AdminUpdateMarketParams = {
        oracleAddress: null,
        active: null,
        tradingFeeBps: null,
        maxLeverage: parsed,
      };
      const sig = await client.adminUpdateMarket(market.account.tokenMint, null, params);
      toast.success(`Max leverage updated to ${parsed}x — ${truncatePubkey(sig)}`);
      await onRefresh();
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Max Leverage
      </div>
      <div className="flex gap-2">
        <input
          type="number"
          value={leverage}
          onChange={(e) => setLeverage(e.target.value)}
          placeholder="e.g. 20"
          className="flex-1 bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-sm text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <button
          onClick={handleUpdate}
          disabled={submitting}
          className="font-mono text-xs px-4 py-2 rounded-[2px] border border-border text-white hover:bg-white/5 transition-colors disabled:opacity-50"
        >
          {submitting ? '...' : 'Set'}
        </button>
      </div>
      <p className="text-xs text-text-tertiary font-sans">
        Current: {market.account.maxLeverage}x
      </p>
    </div>
  );
}

function UpdateOracleConfigPanel({
  client,
  market,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
}) {
  const [maxPriceChangeBps, setMaxPriceChangeBps] = useState('');
  const [minSources, setMinSources] = useState('');
  const [maxStaleness, setMaxStaleness] = useState('');
  const [circuitBreakerBps, setCircuitBreakerBps] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleUpdate = async () => {
    const params: UpdateOracleConfigParams = {
      maxPriceChangeBps: maxPriceChangeBps ? parseInt(maxPriceChangeBps, 10) : null,
      minSources: minSources ? parseInt(minSources, 10) : null,
      maxStalenessSeconds: maxStaleness ? parseInt(maxStaleness, 10) : null,
      circuitBreakerDeviationBps: circuitBreakerBps ? parseInt(circuitBreakerBps, 10) : null,
    };

    // Validate non-null fields are integers
    for (const [key, val] of Object.entries(params) as [string, number | null][]) {
      if (val !== null && (isNaN(val) || !Number.isInteger(val))) {
        toast.error(`${key} must be a valid integer`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const sig = await client.updateOracleConfig(market.account.tokenMint, params);
      toast.success(`Oracle config updated — ${truncatePubkey(sig)}`);
      setMaxPriceChangeBps('');
      setMinSources('');
      setMaxStaleness('');
      setCircuitBreakerBps('');
      await onRefresh();
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Oracle Config
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          type="number"
          value={maxPriceChangeBps}
          onChange={(e) => setMaxPriceChangeBps(e.target.value)}
          placeholder="maxPriceChangeBps"
          className="bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-xs text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <input
          type="number"
          value={minSources}
          onChange={(e) => setMinSources(e.target.value)}
          placeholder="minSources"
          className="bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-xs text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <input
          type="number"
          value={maxStaleness}
          onChange={(e) => setMaxStaleness(e.target.value)}
          placeholder="maxStaleness (s)"
          className="bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-xs text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <input
          type="number"
          value={circuitBreakerBps}
          onChange={(e) => setCircuitBreakerBps(e.target.value)}
          placeholder="circuitBreakerBps"
          className="bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-xs text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
      </div>
      <button
        onClick={handleUpdate}
        disabled={submitting}
        className="w-full font-mono text-xs px-4 py-2 rounded-[2px] border border-border text-white hover:bg-white/5 transition-colors disabled:opacity-50"
      >
        {submitting ? 'Submitting...' : 'Update Oracle Config'}
      </button>
      <p className="text-xs text-text-tertiary font-sans">
        Leave fields empty to skip (null = no change).
      </p>
    </div>
  );
}

function FreezePerkOracle({
  client,
  market,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [frozen, setFrozen] = useState<boolean | null>(null);
  const [loadingState, setLoadingState] = useState(false);

  // Only relevant for PerkOracle markets
  const isPerkOracle = market.account.oracleSource === OracleSource.PerkOracle;

  useEffect(() => {
    if (!isPerkOracle) return;
    setLoadingState(true);
    client
      .fetchPerkOracleNullable(market.account.tokenMint)
      .then((oracle: PerkOracleAccount | null) => {
        setFrozen(oracle?.isFrozen ?? null);
      })
      .catch(() => setFrozen(null))
      .finally(() => setLoadingState(false));
  }, [client, market.account.tokenMint, isPerkOracle]);

  const handleToggle = async (freeze: boolean) => {
    setSubmitting(true);
    try {
      const sig = await client.freezePerkOracle(market.account.tokenMint, freeze);
      toast.success(`Oracle ${freeze ? 'frozen' : 'unfrozen'} — ${truncatePubkey(sig)}`);
      setFrozen(freeze);
      await onRefresh();
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Freeze PerkOracle
      </div>
      {!isPerkOracle ? (
        <p className="text-xs text-text-secondary font-sans">
          N/A — Market uses {oracleSourceLabel(market.account.oracleSource)}
        </p>
      ) : loadingState ? (
        <p className="text-xs text-text-secondary font-sans animate-pulse">Loading oracle state...</p>
      ) : (
        <>
          <p className="text-xs text-text-secondary font-sans">
            Status:{' '}
            <span className={frozen ? 'text-loss' : 'text-profit'}>
              {frozen ? 'FROZEN' : 'ACTIVE'}
            </span>
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => handleToggle(true)}
              disabled={submitting || frozen === true}
              className="font-mono text-xs px-4 py-2 rounded-[2px] border border-loss/30 text-loss hover:bg-loss/10 transition-colors disabled:opacity-50"
            >
              Freeze
            </button>
            <button
              onClick={() => handleToggle(false)}
              disabled={submitting || frozen === false}
              className="font-mono text-xs px-4 py-2 rounded-[2px] border border-profit/30 text-profit hover:bg-profit/10 transition-colors disabled:opacity-50"
            >
              Unfreeze
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SetFallbackOraclePanel({
  client,
  market,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
}) {
  const [address, setAddress] = useState('');
  const [source, setSource] = useState<OracleSource>(OracleSource.Pyth);
  const [submitting, setSubmitting] = useState(false);

  const currentFallback = market.account.fallbackOracleAddress.toBase58();
  const hasCurrentFallback = currentFallback !== PublicKey.default.toBase58();

  const handleSet = async () => {
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(address);
    } catch {
      toast.error('Invalid public key');
      return;
    }

    setSubmitting(true);
    try {
      const params: SetFallbackOracleParams = {
        fallbackOracleSource: source,
        fallbackOracleAddress: pubkey,
      };
      const sig = await client.adminSetFallbackOracle(market.account.tokenMint, params);
      toast.success(`Fallback oracle set — ${truncatePubkey(sig)}`);
      setAddress('');
      await onRefresh();
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async () => {
    setSubmitting(true);
    try {
      const params: SetFallbackOracleParams = {
        fallbackOracleSource: OracleSource.Pyth,
        fallbackOracleAddress: PublicKey.default,
      };
      const sig = await client.adminSetFallbackOracle(market.account.tokenMint, params);
      toast.success(`Fallback oracle removed — ${truncatePubkey(sig)}`);
      await onRefresh();
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Fallback Oracle
      </div>
      {hasCurrentFallback && (
        <p className="text-xs text-text-secondary font-sans">
          Current: <span className="font-mono text-white">{truncatePubkey(currentFallback)}</span>
          {' '}({oracleSourceLabel(market.account.fallbackOracleSource)})
        </p>
      )}
      <input
        type="text"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Oracle address"
        className="w-full bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-xs text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
      />
      <div className="flex gap-2 items-center">
        <select
          value={source}
          onChange={(e) => setSource(Number(e.target.value) as OracleSource)}
          className="bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-xs text-white focus:outline-none focus:border-text-secondary"
        >
          <option value={OracleSource.Pyth}>Pyth</option>
          <option value={OracleSource.PerkOracle}>PerkOracle</option>
          <option value={OracleSource.DexPool}>DexPool</option>
        </select>
        <button
          onClick={handleSet}
          disabled={submitting || !address}
          className="font-mono text-xs px-4 py-2 rounded-[2px] border border-border text-white hover:bg-white/5 transition-colors disabled:opacity-50"
        >
          {submitting ? '...' : 'Set'}
        </button>
        {hasCurrentFallback && (
          <button
            onClick={handleRemove}
            disabled={submitting}
            className="font-mono text-xs px-4 py-2 rounded-[2px] border border-loss/30 text-loss hover:bg-loss/10 transition-colors disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
