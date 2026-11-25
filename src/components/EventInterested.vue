<script setup lang="ts">
import { computed, ref } from 'vue';

/**
 * Personnes ayant coché « Intéressé » sur un événement Discord.
 *
 * Discord n'affiche qu'un compteur ; le site affiche les visages, et les noms
 * au clic. Les avatars sont empilés à la manière de Discord pour rester lisible
 * sur une carte étroite.
 */
interface Person {
  id: string;
  name: string;
  avatarUrl: string | null;
}

const props = defineProps<{
  users?: Person[];
  count?: number;
  /** Variante compacte pour les cartes de la grille. */
  compact?: boolean;
}>();

const open = ref(false);

const people = computed(() => props.users ?? []);
const total = computed(() => Math.max(props.count ?? 0, people.value.length));
const MAX_FACES = 5;
const faces = computed(() => people.value.slice(0, MAX_FACES));
const extra = computed(() => Math.max(0, people.value.length - faces.value.length));
</script>

<template>
  <div v-if="total > 0">
    <button
      type="button"
      class="inline-flex items-center gap-2 rounded transition hover:text-fg-strong"
      :aria-expanded="open"
      :title="people.length ? people.map((p) => p.name).join(', ') : `${total} personne(s) intéressée(s)`"
      @click="open = !open"
    >
      <span v-if="faces.length" class="flex -space-x-1.5">
        <img
          v-for="p in faces"
          :key="p.id"
          :src="p.avatarUrl ?? ''"
          :alt="p.name"
          class="h-5 w-5 rounded-full border border-app-surface object-cover"
          loading="lazy"
        />
        <span
          v-if="extra > 0"
          class="flex h-5 w-5 items-center justify-center rounded-full border border-app-surface bg-app-surface2 text-[9px] font-semibold text-fg-muted"
        >
          +{{ extra }}
        </span>
      </span>
      <span>{{ total }} intéressé{{ total > 1 ? 's' : '' }}</span>
    </button>

    <ul
      v-if="open && people.length"
      class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-muted"
      :class="compact ? '' : 'rounded-lg border border-line bg-app-elevated p-2'"
    >
      <li v-for="p in people" :key="p.id" class="flex items-center gap-1.5">
        <img
          v-if="p.avatarUrl"
          :src="p.avatarUrl"
          alt=""
          class="h-4 w-4 rounded-full"
          loading="lazy"
        />
        <span class="truncate">{{ p.name }}</span>
      </li>
    </ul>
    <p v-else-if="open" class="mt-2 text-[11px] text-fg-faint">
      La liste des intéressés sera disponible à la prochaine synchronisation.
    </p>
  </div>
</template>
