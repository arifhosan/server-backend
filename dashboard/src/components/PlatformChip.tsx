import type { Platform } from '../api/types';
import { PLATFORM_LABEL } from '../lib/sort';
import '../styles/library.css';

export const PlatformChip = ({ platform }: { platform: Platform }) => (
  <span className={`chip-plat chip-${platform}`}>{PLATFORM_LABEL[platform]}</span>
);
