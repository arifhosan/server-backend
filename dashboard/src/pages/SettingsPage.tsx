import type { PublicConnection, PublicDevice } from '../api/types';
import { AccountCard } from '../components/AccountCard';
import { DeviceList } from '../components/DeviceList';
import { ErrorState } from '../components/ErrorState';
import { NewTokenCard } from '../components/NewTokenCard';
import { PsnCard } from '../components/PsnCard';
import { Spinner } from '../components/Spinner';
import { SteamCard } from '../components/SteamCard';
import { useApi } from '../lib/useApi';
import '../styles/settings.css';

const DOWNLOAD = 'https://github.com/ArifHosan/server-backend/releases/latest/download/GameTracker-setup.exe';

export function SettingsPage() {
  const devices = useApi<PublicDevice[]>('/games/devices');
  const conns = useApi<PublicConnection[]>('/games/connections');
  const reload = () => {
    devices.reload();
    conns.reload();
  };

  return (
    <div className="settings">
      <section className="set-col" aria-labelledby="dev-h">
        <h1 id="dev-h">Devices</h1>
        <div className="download" id="download">
          <div className="row-end">
            <div className="grow">
              <div className="strong big">Track PC games with the Game Tracker app</div>
              <div className="muted">Windows 10/11 · runs in the tray · sends play sessions as they happen</div>
            </div>
            <a className="btn primary" href={DOWNLOAD}>
              Download for Windows
            </a>
          </div>
          <ol className="steps">
            <li>Download and install the app. Windows may warn about an unknown publisher: choose More info, then Run anyway.</li>
            <li>Create a device token below.</li>
            <li>Paste it into the app under Settings.</li>
          </ol>
        </div>
        <NewTokenCard onCreated={devices.reload} />
        {devices.error ? (
          <ErrorState error={devices.error} onRetry={devices.reload} />
        ) : devices.data ? (
          <DeviceList devices={devices.data} onChange={devices.reload} />
        ) : (
          <Spinner />
        )}
      </section>
      <section className="set-col" aria-labelledby="con-h">
        <h1 id="con-h">Connections</h1>
        {conns.error ? (
          <ErrorState error={conns.error} onRetry={conns.reload} />
        ) : conns.data ? (
          <>
            <SteamCard conn={conns.data.find((c) => c.provider === 'steam')} onChange={reload} />
            <PsnCard conn={conns.data.find((c) => c.provider === 'psn')} onChange={reload} />
          </>
        ) : (
          <Spinner />
        )}
        <AccountCard />
      </section>
    </div>
  );
}
