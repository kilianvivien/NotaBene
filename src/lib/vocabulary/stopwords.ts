/**
 * Everyday words the harvest leaves out.
 *
 * Only words of six letters or more are listed, because nothing shorter is
 * harvested at all. The list is short on purpose: its job is not to make the
 * vocabulary "technical", it is to stop the handful of long connectives every
 * lecture repeats — "également", "therefore" — from outranking the course's
 * own terms on frequency alone and taking the suggestion slot for their
 * prefix. Keys are folded (see `foldKey`), so accents do not matter here.
 */
import { foldKey } from './text';

const ENGLISH = `
about above across actually after again against almost already although always
among another anyone anything around because become becomes been before behind
being below besides better between beyond cannot certain certainly different
during either enough especially everything example following further general
generally however important include including instead itself little mainly
might myself nothing number others otherwise perhaps possible probably rather
really second should similar something sometimes still through therefore these
things though thought throughout together towards under unless until usually
various whatever whether which while within without would yourself
`;

const FRENCH = `
actuellement ailleurs ainsi alors après assez aujourd aussi autant autour
autres autrement avant avoir beaucoup besoin cependant certain certaine
certaines certains chacun chaque comme comment compte contre dans davantage
dedans dehors déjà depuis dernier dernière derrière devant deuxième donc dont
durant également elles encore enfin ensemble ensuite entre environ exemple
faire façon généralement grâce jamais jusqu jusque lequel laquelle lesquels
lesquelles leurs lorsque maintenant malgré manière moins notamment notre nous
parce parfois parmi partir partout pendant permet permettent personne peuvent
peut-être plusieurs plutôt pour pourquoi pourtant pouvoir première premier
presque puisque quand quelle quelles quelque quelques quels simplement
seulement selon souvent surtout tandis toujours toutefois toutes troisième
vraiment
`;

export const STOPWORD_KEYS: ReadonlySet<string> = new Set(
  `${ENGLISH} ${FRENCH}`
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => foldKey(word)),
);
