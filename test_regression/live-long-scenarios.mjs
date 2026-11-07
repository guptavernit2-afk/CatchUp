// Four salient facts compete with unrelated chatter. Unlike two-message smoke
// cases, these test real selection/compression under the four-message limit.
const chatter = [
  'Alice: The kitchen has a new coffee machine.', 'Bob: My train arrived early this morning.',
  'Carol: The weekend photos look nice.', 'Dave: The weather is sunny here.',
  'Alice: My headphones are on the desk.', 'Bob: The lunch menu has changed.',
  'Carol: The office plants look healthy.', 'Dave: The bus stop is near the bakery.',
  'Alice: I enjoyed the concert yesterday.', 'Bob: The cafe has outdoor seating.',
  'Carol: My new chair arrived this morning.', 'Dave: The park was quiet yesterday.',
  'Alice: The library has a new reading room.', 'Bob: My old keyboard is still working.',
  'Carol: The wall calendar has a landscape photo.', 'Dave: The printer is next to the window.',
  'Alice: My notebook has a blue cover.', 'Bob: The flowers arrived yesterday.',
  'Carol: The water bottle is on the shelf.', 'Dave: The hallway lights are bright.'
];
const facts = [
  'Alice: I will update the release checklist by Friday.',
  'Bob: I will review the login tests tomorrow.',
  'Carol: We decided to use PostgreSQL for storage.',
  'Dave: API access is still pending.'
];
export const longScenarios = [
  ['late-facts', [13,15,17,19]], ['spread-facts', [2,7,12,18]],
  ['early-facts', [0,1,2,3]], ['middle-facts', [5,8,10,11]], ['separated-facts', [1,4,14,19]]
].map(([id, positions]) => {
  const lines = [...chatter]; positions.forEach((position, index) => { lines[position] = facts[index]; });
  return { id: `long-${id}`, chat: lines.join('\n'), tasks: [[positions[0]+1,'Alice','confirmed'],[positions[1]+1,'Bob','confirmed']],
    decisions: [positions[2]+1], questions: [positions[3]+1], summaryIncludes: ['release checklist','login tests','PostgreSQL','API access'] };
});
