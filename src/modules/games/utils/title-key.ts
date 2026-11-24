/** Platform-independent match key: "Pokémon™ Legends" and "pokemon legends" collapse to the same value. */
export function titleKey(title: string): string {
  return (
    title
      // Before NFKD: it turns ™ into "TM" and ´ into a space plus a combining accent.
      .replace(/[™®©]/g, '')
      // Apostrophe look-alikes: ' ‘ ’ ‛ ʼ ` ´ ′ (Sony writes "Tom Clancy‘s").
      .replace(/['‘’‛ʼ`´′]/g, '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  );
}
