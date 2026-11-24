import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GameArt, initials } from './GameArt';

describe('GameArt', () => {
  it('initials skip punctuation and symbols', () => {
    expect(initials('Tom Clancy’s Rainbow Six® Siege')).toBe('TC');
    expect(initials('Avowed')).toBe('AV');
    expect(initials('(1) — ')).toBe('1');
    expect(initials('')).toBe('?');
  });

  it('shows the tinted initials tile when there is no art', () => {
    const { container } = render(<GameArt imageUrl={null} hasIcon={false} libraryGameId={1} title="Forza Horizon 5" />);
    expect(container.querySelector('img')).toBeNull();
    const tile = container.querySelector('.art-tile') as HTMLElement;
    expect(tile.textContent).toBe('FH');
    expect(tile.style.background).not.toBe('');
  });

  it('a failing image falls back to the icon, then to the tile', () => {
    const { container } = render(
      <GameArt imageUrl="https://x/missing.jpg" hasIcon libraryGameId={7} iconLibraryGameId={8} title="Yakuza 0" />,
    );
    const img = () => container.querySelector('img');
    expect(img()?.getAttribute('src')).toBe('https://x/missing.jpg');
    fireEvent.error(img()!);
    expect(img()?.getAttribute('src')).toBe('/api/games/library/8/icon');
    fireEvent.error(img()!);
    expect(img()).toBeNull();
    expect(container.querySelector('.art-tile')?.textContent).toBe('Y0');
  });
});
