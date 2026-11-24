/** Platform-independent match key: "Pokémon™ Legends" and "pokemon legends" collapse to the same value. */
export function titleKey(title: string): string {
  return title
    .replace(/[™®©]/g, '') // NFKD would turn ™ into "TM"
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
