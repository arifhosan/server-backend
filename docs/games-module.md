# Games module

Design and rationale: `docs/superpowers/specs/2026-11-24-game-tracker-design.md`. `DB_SYNC` stays off, so every schema change below is applied by hand before deploy.

```sql
ALTER TABLE user ADD COLUMN timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Berlin';
```

```sql
CREATE TABLE device (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  tokenHash CHAR(64) NOT NULL UNIQUE,
  tokenPrefix VARCHAR(12) NOT NULL,
  createdAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  lastSeenAt DATETIME(6) NULL,
  revokedAt DATETIME(6) NULL,
  INDEX (userId)
);
CREATE TABLE connection (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  provider VARCHAR(16) NOT NULL,
  externalId VARCHAR(64) NOT NULL,
  displayName VARCHAR(255) NOT NULL DEFAULT '',
  secret TEXT NULL,
  secretExpiresAt DATETIME(6) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ok',
  createdAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  lastSyncAt DATETIME(6) NULL,
  lastSuccessAt DATETIME(6) NULL,
  lastError VARCHAR(500) NULL,
  lastGameCount INT NULL,
  UNIQUE KEY (userId, provider)
);
CREATE TABLE sync_run (
  id INT AUTO_INCREMENT PRIMARY KEY,
  connectionId INT NOT NULL,
  startedAt DATETIME(6) NOT NULL,
  finishedAt DATETIME(6) NULL,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  gameCount INT NULL,
  error VARCHAR(500) NULL,
  INDEX (connectionId, startedAt)
);
CREATE TABLE library_game (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  platform VARCHAR(16) NOT NULL,
  externalId VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL,
  titleKey VARCHAR(255) NOT NULL,
  totalSeconds BIGINT NULL,
  totalChangedAt DATETIME(6) NULL,
  lastPlayedAt DATETIME(6) NULL,
  UNIQUE KEY (userId, platform, externalId),
  INDEX (userId, titleKey)
);
CREATE TABLE play_session (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  libraryGameId INT NOT NULL,
  source VARCHAR(16) NOT NULL,
  deviceId INT NULL,
  startedAt DATETIME(6) NOT NULL,
  endedAt DATETIME(6) NOT NULL,
  seconds INT NOT NULL,
  legacyRef VARCHAR(32) NULL UNIQUE,
  INDEX (userId, startedAt),
  INDEX (libraryGameId, startedAt),
  INDEX (deviceId, libraryGameId, startedAt)
);
```

`legacyRef` (`game:<id>` / `game_old:<id>`) makes the legacy import idempotent.
