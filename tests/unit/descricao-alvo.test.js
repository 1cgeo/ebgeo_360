/**
 * @module tests/unit/descricao-alvo
 * @description O que a tela diz de um alvo: distancia e, so quando muda de
 * andar, qual andar.
 *
 * POR QUE ESTE TESTE EXISTE. Duas telas descrevem o MESMO alvo, a lista de
 * alvos e o rotulo do preview. Descricao escrita em dois lugares vira duas
 * descricoes diferentes do mesmo objeto, e o operador nao tem como saber qual
 * das duas mentiu. A regra virou funcao pura, e o que e dado se testa.
 *
 * Os numeros abaixo sao MEDIDOS no beira_rio, nao inventados.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { descreverAlvo } from '../../public/calibration/js/descricao.js';
import { desenharDescricao, StreetViewRenderer } from '../../public/calibration/js/renderer.js';
import { StreetViewProjector } from '../../public/calibration/js/projector.js';
import { NAV_CONSTANTS } from '../../public/calibration/js/constants.js';

// O elevador do 5o para o 6o andar, o caso que da nome a regra: 1,84 m em
// planta e 12,83 m de subida real.
const NO_QUINTO = { floor_level: 5, ele: 17.6 };
const ELEVADOR_6O = {
    floor_level: 6, ele: 30.3, distance: 1.84, floor_label: '6º andar',
};

describe('descreverAlvo', () => {
    it('sempre diz a distancia', () => {
        const d = descreverAlvo({ distance: 7.8, floor_level: 5 }, NO_QUINTO);
        assert.equal(d.distancia, '7.8m');
    });

    it('a forma CURTA nao tem decimal nem unidade', () => {
        // E a que vai sobre a fotografia, onde o texto disputa espaco com a
        // imagem. Quem le quer saber se sao 2 ou 20 passos.
        assert.equal(descreverAlvo({ distance: 7.8 }, null).distanciaCurta, '8');
        assert.equal(descreverAlvo({ distance: 1.82 }, null).distanciaCurta, '2');
        assert.equal(descreverAlvo({ distance: 28.34 }, null).distanciaCurta, '28');
    });

    it('as duas formas convivem, e a precisa continua na lista', () => {
        const d = descreverAlvo({ distance: 1.84 }, null);
        assert.equal(d.distancia, '1.8m');
        assert.equal(d.distanciaCurta, '2');
    });

    it('sem distancia, nenhuma das duas formas existe', () => {
        const d = descreverAlvo({ floor_level: 5 }, NO_QUINTO);
        assert.equal(d.distancia, null);
        assert.equal(d.distanciaCurta, null);
    });

    it('mesmo andar nao ganha marca de andar', () => {
        const d = descreverAlvo(
            { distance: 7.8, floor_level: 5, floor_label: '5º andar' }, NO_QUINTO);
        assert.equal(d.andar, null);
    });

    it('outro andar diz QUAL andar, pelo rotulo do alvo', () => {
        const d = descreverAlvo(ELEVADOR_6O, NO_QUINTO);
        assert.equal(d.andar, '6º andar');
    });

    it('o nivel 0 aparece como Externo, e nao como zero', () => {
        const d = descreverAlvo(
            { distance: 12.0, floor_level: 0, floor_label: 'Externo' },
            { floor_level: 1, ele: 0 });
        assert.equal(d.andar, 'Externo');
    });

    it('sem rotulo, cai no nivel, que ainda diz mais que nada', () => {
        const d = descreverAlvo(
            { distance: 12.0, floor_level: 2, floor_label: null },
            { floor_level: 1, ele: 0 });
        assert.equal(d.andar, 'nivel 2');
    });

    it('a distancia sai em PLANTA, sem somar o desnivel', () => {
        // A cota NAO acompanha o andar neste acervo: o 4o andar inteiro em
        // zero, a area externa ate 100 m. Somar 12,7 m de "subida" a este alvo
        // daria um numero preciso e falso. Quem avisa da troca e o rotulo.
        const d = descreverAlvo(ELEVADOR_6O, NO_QUINTO);
        assert.equal(d.distancia, '1.8m');
        assert.equal(d.andar, '6º andar');
        assert.equal(d.distancia3d, undefined);
    });

    it('a cota do alvo nao muda nada, nem a do observador', () => {
        // Duas cotas absurdas, mesma resposta: a descricao nao le `ele`.
        const comCota = descreverAlvo(
            { distance: 9.0, floor_level: 2, ele: 118.3, floor_label: '2º andar' },
            { floor_level: 1, ele: 0 });
        const semCota = descreverAlvo(
            { distance: 9.0, floor_level: 2, floor_label: '2º andar' },
            { floor_level: 1 });

        assert.deepEqual(comCota, semCota);
        assert.equal(comCota.distancia, '9.0m');
    });

    it('projeto SEM andar declarado nao ganha marca nenhuma', () => {
        // Os 28 projetos externos tem floor_level 1 em tudo. A tela deles nao
        // pode mudar por causa desta regra.
        const d = descreverAlvo(
            { distance: 15.2, floor_level: 1 }, { floor_level: 1, ele: 0 });
        assert.equal(d.andar, null);
        assert.equal(d.distancia, '15.2m');
    });

    it('alvo sem distancia devolve null, e nao um NaN na tela', () => {
        const d = descreverAlvo({ floor_level: 5 }, NO_QUINTO);
        assert.equal(d.distancia, null);
    });

    it('nao estoura sem alvo nem sem camera', () => {
        assert.equal(descreverAlvo(null, null).distancia, null);
        assert.equal(descreverAlvo(undefined, undefined).andar, null);
        assert.equal(descreverAlvo({ distance: 3 }, null).distancia, '3.0m');
    });
});

/**
 * Contexto de canvas falso, que so ANOTA o que foi pedido. O marcador verde
 * desenha na fotografia, e sem espiao a unica prova seria o olho de quem usa.
 *
 * Nao tem `measureText` de proposito: o contexto de verdade tem, e o codigo
 * precisa funcionar nos dois. Uma placa medida com NaN nao desenha.
 */
function ctxFalso() {
    const textos = [];
    const placas = [];
    const circulos = [];
    return {
        textos, placas, circulos,
        save() {}, restore() {}, translate() {}, beginPath() {}, stroke() {},
        arc(x, y, r) { circulos.push({ x, y, r, cor: this.fillStyle }); },
        fill() {},
        fillRect(x, y, w, h) { placas.push({ x, y, w, h, cor: this.fillStyle }); },
        strokeRect() {},
        strokeText(t, x, y) { textos.push({ t, x, y, tipo: 'contorno' }); },
        fillText(t, x, y) { textos.push({ t, x, y, tipo: 'corpo', cor: this.fillStyle }); },
    };
}

/** Um renderizador com canvas falso, para exercitar o marcador inteiro. */
function rendererFalso() {
    const ctx = ctxFalso();
    const canvas = { width: 1200, height: 800, getContext: () => ctx };
    return { renderer: new StreetViewRenderer(canvas), ctx };
}

describe('desenharDescricao, o texto sob o marcador verde', () => {
    it('escreve a distancia CURTA, e ela vai ABAIXO do marcador', () => {
        const ctx = ctxFalso();
        desenharDescricao(ctx, 10, { distanciaCurta: '8' });

        const corpos = ctx.textos.filter(d => d.tipo === 'corpo');
        assert.deepEqual(corpos.map(d => d.t), ['8']);
        assert.ok((corpos[0].y) > (10), 'o texto invadiu o marcador');
    });

    it('a forma precisa NAO vai para o canvas', () => {
        // A regua que separa as duas formas. Sem ela o marcador voltaria a
        // escrever "7.8m" no dia em que alguem trocasse o campo lido.
        const ctx = ctxFalso();
        desenharDescricao(ctx, 10, { distancia: '7.8m' });

        assert.equal(ctx.textos.length, 0,
            `escreveu a forma precisa sobre a foto: ${JSON.stringify(ctx.textos)}`);
    });

    it('o andar NAO vai escrito por extenso aqui, ele vai na bola', () => {
        const ctx = ctxFalso();
        desenharDescricao(ctx, 10, { distanciaCurta: '2', andar: '6º andar' });

        const corpos = ctx.textos.filter(d => d.tipo === 'corpo');
        assert.deepEqual(corpos.map(d => d.t), ['2']);
    });

    it('a placa e OPACA, e cobre o numero por inteiro', () => {
        // A razao de existir: com dois marcadores sobrepostos, contorno de
        // texto deixa os dois numeros legiveis um sobre o outro. A placa sem
        // transparencia esconde o de tras.
        const ctx = ctxFalso();
        desenharDescricao(ctx, 10, { distanciaCurta: '28' });

        assert.equal(ctx.placas.length, 1, 'nenhuma placa desenhada');
        const placa = ctx.placas[0];
        assert.ok(!/rgba|transparent/i.test(placa.cor),
            `a placa saiu translucida: ${placa.cor}`);
        assert.ok((placa.w) > (0) && (placa.h) > (0), 'placa com medida invalida');
        assert.ok(Number.isFinite(placa.w),
            'largura NaN: sem measureText a placa nao desenha');

        // O numero cai DENTRO da placa, e nao ao lado dela.
        const texto = ctx.textos.find(d => d.tipo === 'corpo');
        assert.ok((texto.y) > (placa.y) && (texto.y) < (placa.y + placa.h),
            'o numero saiu fora da propria placa');
    });

    it('a placa vem ANTES do numero, senao tapa o que devia realcar', () => {
        const ctx = ctxFalso();
        const ordem = [];
        const original = { fillRect: ctx.fillRect, fillText: ctx.fillText };
        ctx.fillRect = function (...a) { ordem.push('placa'); original.fillRect.apply(this, a); };
        ctx.fillText = function (...a) { ordem.push('texto'); original.fillText.apply(this, a); };

        desenharDescricao(ctx, 10, { distanciaCurta: '8' });

        assert.deepEqual(ordem, ['placa', 'texto']);
    });

    it('sem descricao nao escreve nada, e nao estoura', () => {
        for (const vazio of [null, undefined, {}, { distanciaCurta: null }]) {
            const ctx = ctxFalso();
            desenharDescricao(ctx, 10, vazio);
            assert.equal(ctx.textos.length, 0);
            assert.equal(ctx.placas.length, 0);
        }
    });
});

describe('o marcador verde da vizinha', () => {
    const base = { screenX: 100, screenY: 200, radius: 10, distance: 3, rank: 1 };

    it('o andar vai no CENTRO da bola, como glifo', () => {
        const { renderer, ctx } = rendererFalso();
        renderer.renderNearbyMarker({
            ...base, floorDelta: 1, floorLevel: 6, floorLabel: '6º andar',
            descricao: { distanciaCurta: '3' },
        });

        const centro = ctx.textos.find(d => d.x === 0 && d.y === 0);
        assert.ok(centro, 'nada escrito no centro da bola');
        assert.equal(centro.t, '6');
    });

    it('o glifo segue a mesma regra da esfera: Externo vira E', () => {
        const { renderer, ctx } = rendererFalso();
        renderer.renderNearbyMarker({
            ...base, floorDelta: -1, floorLevel: 0, floorLabel: 'Externo',
            descricao: { distanciaCurta: '9' },
        });

        assert.equal(ctx.textos.find(d => d.x === 0 && d.y === 0).t, 'E');
    });

    it('mesmo andar nao ganha glifo nenhum', () => {
        const { renderer, ctx } = rendererFalso();
        renderer.renderNearbyMarker({
            ...base, floorDelta: 0, floorLevel: 5, floorLabel: '5º andar',
            descricao: { distanciaCurta: '3' },
        });

        assert.equal(ctx.textos.find(d => d.x === 0 && d.y === 0), undefined);
    });

    it('o disco e OPACO, senao dois marcadores viram uma mancha', () => {
        const { renderer, ctx } = rendererFalso();
        renderer.renderNearbyMarker({ ...base, floorDelta: 0, descricao: null });

        const disco = ctx.circulos.find(c => c.r === base.radius);
        assert.ok(disco, 'o disco nao foi desenhado');
        assert.ok(!/rgba|transparent/i.test(disco.cor),
            `o disco saiu translucido: ${disco.cor}`);
    });
});

describe('elevacaoDeVizinha', () => {
    function proj() {
        const p = new StreetViewProjector(1200, 800);
        p.setCameraConfig({ lon: 0, lat: 0 });
        return p;
    }

    it('mesmo andar fica na faixa dos alvos, como sempre', () => {
        const p = proj();
        assert.ok(Math.abs((p.elevacaoDeVizinha(0)) - (p.elevationDeg(0))) < 1e-12);
        assert.ok(Math.abs((p.elevacaoDeVizinha(null)) - (p.elevationDeg(0))) < 1e-12);
    });

    it('cada andar de diferenca fica numa altura DIFERENTE', () => {
        // A razao da regra: com a busca em todos os andares aparecem sete
        // niveis de uma vez, e duas alturas so viram uma pilha.
        const p = proj();
        const alturas = [1, 2, 3, 4, 5, 6].map(d => p.elevacaoDeVizinha(d));

        for (let i = 1; i < alturas.length; i++) {
            assert.ok((alturas[i]) > (alturas[i - 1]),
                `andar ${i + 1} nao subiu em relacao ao ${i}`);
        }
        assert.equal(new Set(alturas).size, alturas.length);
    });

    it('subir e descer sao espelhos', () => {
        const p = proj();
        for (const d of [1, 2, 3, 6]) {
            assert.ok(Math.abs((p.elevacaoDeVizinha(d)) + (p.elevacaoDeVizinha(-d))) < 1e-12);
        }
    });

    it('quem sobe fica acima do horizonte, quem desce abaixo', () => {
        const p = proj();
        for (const d of [1, 2, 3, 6, 12]) {
            assert.ok((p.elevacaoDeVizinha(d)) > (0));
            assert.ok((p.elevacaoDeVizinha(-d)) < (0));
        }
    });

    it('o primeiro degrau bate com o do alvo que troca de andar', () => {
        // Vizinha de um andar acima e alvo de um andar acima nascem na mesma
        // altura: sao a mesma informacao, e alturas diferentes mentiriam.
        const p = proj();
        assert.ok(Math.abs((p.elevacaoDeVizinha(1)) - (p.elevacaoComAndar(0, 1))) < 1e-12);
    });

    it('a altura para de crescer no teto de degraus', () => {
        // Sem teto, a vizinha do outro extremo do predio sairia da tela.
        const p = proj();
        const teto = NAV_CONSTANTS.ANDAR_DEGRAUS_MAX;
        assert.ok(Math.abs((p.elevacaoDeVizinha(teto)) - (p.elevacaoDeVizinha(teto + 5))) < 1e-12);
    });
});
