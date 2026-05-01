'use client';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import IncidentTimeline from '@/components/IncidentTimeline';
import MainnetSoonCard from '@/components/MainnetSoonCard';
import { useNetwork } from '@/lib/useNetwork';

export default function IncidentsPage() {
  const [network, setNetwork] = useNetwork();

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader
          network={network}
          onNetworkChange={setNetwork}
          liveState="live"
          lastUpdate={null}
        />
        <main className="site-main">
          <TabNav />

          <div style={{
            marginBottom: 20, display: 'flex', alignItems: 'center',
            gap: 12, flexWrap: 'wrap',
          }}>
            <span className="badge-gold">
              {network === 'testnet' ? 'Monad Testnet' : 'Monad Mainnet'}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Unified chronology of every network anomaly observed by this validator.
            </span>
          </div>

          {network === 'testnet' ? (
            <IncidentTimeline />
          ) : (
            <MainnetSoonCard
              title="INCIDENT TIMELINE"
              description="Reorgs, validator-set churn, retry spikes, block stalls and critical logs are detected by our anomaly detectors which scrape Prometheus + Loki from a node we operate. Mainnet feed will activate when we run a mainnet validator."
            />
          )}
        </main>
      </div>
    </>
  );
}
