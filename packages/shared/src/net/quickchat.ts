// Quick chat presets (same categories and layout as the real game).
export const QUICK_CHAT: { title: string; options: string[] }[] = [
  { title: 'Información', options: ['¡Lo tengo!', '¡Necesito boost!', '¡Toma el tiro!', '¡Defiendo!'] },
  { title: 'Felicitaciones', options: ['¡Qué tiro!', '¡Gran pase!', '¡Gracias!', '¡Qué atajada!'] },
  { title: 'Reacciones', options: ['¡OMG!', '¡Noooo!', '¡Wow!', '¡Casi!'] },
  { title: 'Disculpas', options: ['$#@%!', '¡No hay problema!', '¡Uy!', '¡Perdón!'] },
];

export const isQuickChat = (text: string) => QUICK_CHAT.some((c) => c.options.includes(text));
