export function permutations(values) {
  if (values.length <= 1) return [values.slice()];
  const output = [];
  for (let index = 0; index < values.length; index += 1) {
    const head = values[index];
    const tail = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const rest of permutations(tail)) output.push([head, ...rest]);
  }
  return output;
}
