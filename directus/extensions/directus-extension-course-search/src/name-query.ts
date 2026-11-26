import { onBeforeUnmount, ref } from 'vue';

// How long typing in the name field rests before it searches.
const nameDelay = 300;

// The name field as typed, and the name the search uses: the typed name
// once typing rests, or at once when `apply` is called.
export const useNameQuery = () => {
  const name = ref('');
  const query = ref('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const apply = (): void => {
    clearTimeout(timer);
    query.value = name.value.trim();
  };
  onBeforeUnmount(() => {
    clearTimeout(timer);
  });
  return {
    apply,
    name,
    query,
    set: (value: string): void => {
      name.value = value;
      clearTimeout(timer);
      timer = setTimeout(apply, nameDelay);
    },
  };
};
