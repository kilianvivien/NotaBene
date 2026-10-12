/** Opt-in smoke test against the real provider, with synthetic notes only.
 * NOTABENE_LINK_EVAL=1 pnpm test -- src/lib/ai/linkSuggestions.live.test.ts
 * Uses MISTRAL_API_KEY from the environment; never prints it or reasoning. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiTransport } from '@/lib/adapters';
import { requestLinkSuggestions } from './linkSuggestions';
import { providerById } from './providers';

afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.env.NOTABENE_LINK_EVAL !== '1')('live link suggestions', () => {
  it('returns validated suggestions from GLM 5.3', async () => {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) throw new Error('MISTRAL_API_KEY is required');
    const send = aiTransport.request.bind(aiTransport);
    const answers: { finishReason: string | undefined; characters: number }[] = [];
    vi.spyOn(aiTransport, 'request').mockImplementation(async (request) => {
      const response = await send(request);
      const body = JSON.parse(response.body);
      const choice = body.choices?.[0];
      const content = choice?.message?.content;
      const answer =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((part) => part.type === 'text')
                .map((part) => part.text ?? '')
                .join('')
            : '';
      answers.push({ finishReason: choice?.finish_reason, characters: answer.length });
      console.info(
        'Link suggestion response:',
        JSON.stringify({
          status: response.status,
          finishReason: choice?.finish_reason,
          answerCharacters: answer.length,
          outputTokens: body.usage?.completion_tokens,
          chunkTypes: Array.isArray(content)
            ? content.map((part) => part.type)
            : undefined,
        }),
      );
      return response;
    });
    const topics = [
      ['Amortissement', 'La dissipation de l’énergie freine les oscillations.'],
      [
        'Oscillations amorties',
        'Une masse reliée à un ressort et un amortisseur perd de l’énergie.',
      ],
      [
        'Résonance',
        'Une excitation périodique amplifie les oscillations près de la fréquence propre.',
      ],
      [
        'Gestion de crise',
        'Un poste de commandement coordonne les secours après une catastrophe.',
      ],
      [
        'Retour d’expérience cyclone',
        'Après le cyclone, les secours ont analysé les difficultés de coordination.',
      ],
      [
        'Évacuation',
        'Les plans d’évacuation organisent les déplacements et l’accueil des populations.',
      ],
      [
        'Droit administratif',
        'Les autorités publiques doivent justifier leurs décisions et respecter la légalité.',
      ],
      [
        'Déontologie',
        'La prévention des conflits d’intérêts guide les décisions des agents publics.',
      ],
      [
        'Management',
        'Le responsable fixe les objectifs et développe la coopération au sein de l’équipe.',
      ],
      [
        'Communication en équipe',
        'L’écoute et la clarification des responsabilités facilitent la coopération.',
      ],
      [
        'Transition écologique',
        'La réduction des émissions passe par les transports, les bâtiments et l’énergie.',
      ],
      [
        'Rénovation énergétique',
        'L’isolation des bâtiments publics réduit les consommations et les émissions.',
      ],
      [
        'Planification écologique',
        'La trajectoire de réduction des émissions fixe des objectifs par secteur.',
      ],
      [
        'Budget public',
        'Les dépenses et les recettes sont prévues et votées chaque année.',
      ],
      ['Courses', 'Acheter du lait et du pain.'],
    ];
    const result = await requestLinkSuggestions({
      provider: {
        definition: providerById('mistral')!,
        baseUrl: 'https://api.mistral.ai/v1',
        apiKey,
        model: 'zai-glm-5-3',
      },
      notes: topics.map(([title, excerpt], index) => ({
        id: `synthetic-${index}`,
        title: title!,
        excerpt: excerpt!,
        course: null,
      })),
      linked: new Set(),
      language: 'fr',
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(12);
    expect(answers.length).toBeGreaterThan(0);
    expect(
      answers.every((answer) => answer.finishReason === 'stop' && answer.characters > 0),
    ).toBe(true);
  }, 240_000);
});
