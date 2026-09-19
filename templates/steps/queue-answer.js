// Closes a queue item according to the answer given on the `reply` human step.
const SNOOZE = { 'Завтра': 'tomorrow', 'Понедельник': 'monday', 'Через неделю': 'week' };

export default async function queueAnswer(ctx) {
  const { queue, name: id } = ctx.item;
  const answer = ctx.item.steps.reply.answer;
  let it;
  if (answer === 'Отправил') it = ctx.queue.done(queue, id);
  else if (SNOOZE[answer]) it = ctx.queue.snooze(queue, id, SNOOZE[answer]);
  else if (answer === 'Не нужно') it = ctx.queue.drop(queue, id, 'answer: Не нужно');
  else throw new Error(`unexpected answer "${answer ?? ''}" — the item stays open`);   // never lose a debt on a typo
  ctx.log(`${queue}/${id}: ${it.status}${it.until ? ` until ${it.until}` : ''}${it.note ? ` (${it.note})` : ''}`);
  return { status: it.status, until: it.until || '' };
}
