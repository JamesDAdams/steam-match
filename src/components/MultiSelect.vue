<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

/**
 * Liste déroulante à cases à cocher (multi-sélection).
 *
 * POURQUOI CE COMPOSANT : les pastilles alignées devenaient illisibles dès
 * vingt entrées (genres, tags, membres). Ici, un bouton résume la sélection et
 * le panneau affiche une liste cochable — comme un `<select multiple>` natif,
 * mais lisible et filtrable.
 */
export interface MultiSelectOption {
  value: string;
  label: string;
  /** Nombre affiché à droite (jeux concernés, par exemple). */
  count?: number;
  /** Petit avatar devant le libellé (membres). */
  avatar?: string | null;
}

const props = withDefaults(
  defineProps<{
    modelValue: string[];
    options: MultiSelectOption[];
    /** Libellé du bouton quand rien n'est sélectionné. */
    emptyLabel?: string;
    /** Valeur spéciale « tout » : cochée quand la sélection est vide. */
    allLabel?: string;
    searchPlaceholder?: string;
    /** Texte au-dessus du bouton. */
    label?: string;
  }>(),
  {
    emptyLabel: 'Tout',
    allLabel: undefined,
    searchPlaceholder: 'Rechercher…',
    label: undefined,
  },
);

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();

const open = ref(false);
const search = ref('');
const root = ref<HTMLElement | null>(null);

const selected = computed(() => new Set(props.modelValue));

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter((o) => o.label.toLowerCase().includes(q));
});

const summary = computed(() => {
  if (props.modelValue.length === 0) return props.allLabel ?? props.emptyLabel;
  if (props.modelValue.length === 1) {
    const only = props.options.find((o) => o.value === props.modelValue[0]);
    return only?.label ?? '1 sélection';
  }
  return `${props.modelValue.length} sélectionnés`;
});

function toggle(value: string) {
  emit(
    'update:modelValue',
    selected.value.has(value)
      ? props.modelValue.filter((v) => v !== value)
      : [...props.modelValue, value],
  );
}

function clearAll() {
  emit('update:modelValue', []);
  search.value = '';
}

/** Fermeture au clic extérieur (le panneau est ancré au bouton). */
function onDocumentClick(event: MouseEvent) {
  if (!open.value) return;
  if (root.value && !root.value.contains(event.target as Node)) open.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') open.value = false;
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onKeydown);
});

// Le panneau se referme quand on quitte le composant (changement d'onglet…).
watch(
  () => props.options.length,
  () => {
    if (open.value && props.options.length === 0) open.value = false;
  },
);
</script>

<template>
  <div ref="root" class="relative">
    <p v-if="label" class="mb-1 block text-xs font-medium text-fg-muted">{{ label }}</p>

    <button
      type="button"
      class="flex h-9 w-full items-center gap-2 rounded border border-line bg-app-bg px-3 text-left text-sm text-fg transition hover:border-line-strong"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="min-w-0 flex-1 truncate">{{ summary }}</span>
      <span
        v-if="modelValue.length > 0"
        class="shrink-0 rounded bg-brand-soft px-1.5 text-[11px] font-semibold text-brand"
      >
        {{ modelValue.length }}
      </span>
      <svg
        class="h-4 w-4 shrink-0 text-fg-faint transition"
        :class="open ? 'rotate-180' : ''"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <div
      v-if="open"
      class="absolute left-0 z-30 mt-1 w-full min-w-[16rem] rounded-lg border border-line bg-app-surface shadow-xl"
    >
      <div class="border-b border-line p-2">
        <input
          v-model="search"
          type="text"
          class="input h-8 !py-1 text-sm"
          :placeholder="searchPlaceholder"
        />
      </div>

      <ul class="max-h-64 overflow-auto py-1">
        <!-- « Tout » : cocher cette ligne vide la sélection. -->
        <li v-if="allLabel">
          <label
            class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-app-surface2"
          >
            <input
              type="checkbox"
              class="h-4 w-4 rounded border-line-strong bg-app-bg"
              :checked="modelValue.length === 0"
              @change="clearAll"
            />
            <span class="font-medium text-fg">{{ allLabel }}</span>
          </label>
        </li>

        <li v-for="option in filtered" :key="option.value">
          <label
            class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-app-surface2"
          >
            <input
              type="checkbox"
              class="h-4 w-4 rounded border-line-strong bg-app-bg"
              :checked="selected.has(option.value)"
              @change="toggle(option.value)"
            />
            <img
              v-if="option.avatar"
              :src="option.avatar"
              :alt="option.label"
              class="h-5 w-5 rounded-full object-cover"
              loading="lazy"
            />
            <span class="min-w-0 flex-1 truncate text-fg">{{ option.label }}</span>
            <span v-if="option.count !== undefined" class="shrink-0 text-[11px] text-fg-faint">
              {{ option.count }}
            </span>
          </label>
        </li>

        <li v-if="filtered.length === 0" class="px-3 py-2 text-xs text-fg-faint">
          Aucun résultat.
        </li>
      </ul>

      <div
        v-if="modelValue.length > 0"
        class="flex items-center justify-between border-t border-line px-3 py-1.5"
      >
        <span class="text-[11px] text-fg-faint">{{ modelValue.length }} sélectionné(s)</span>
        <button type="button" class="text-[11px] text-brand hover:underline" @click="clearAll">
          Tout décocher
        </button>
      </div>
    </div>
  </div>
</template>
