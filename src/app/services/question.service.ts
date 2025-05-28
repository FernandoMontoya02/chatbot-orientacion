import { Injectable } from '@angular/core';
import { Firestore, doc, getDoc } from '@angular/fire/firestore';

@Injectable({ providedIn: 'root' })
export class QuestionService {
  constructor(private firestore: Firestore) {}

  async getRandomQuestionsByCompetence(config: number | { [key: string]: number }): Promise<{ key: string, text: string }[]> {
    const etiquetas: { [key: string]: string } = {
      digital: 'Digital',
      matematica: 'Matemática',
      comunicacion: 'Comunicacional',
      socioemocional: 'Socioemocional'
    };
  
    const competencias = Object.keys(etiquetas);
  
    if (typeof config === 'number') {
      const total = config;
      const base = Math.floor(total / competencias.length);
      const resto = total % competencias.length;
    
      const repartido: { [key: string]: number } = {};
      competencias.forEach((comp, index) => {
        repartido[comp] = base + (index < resto ? 1 : 0);
      });
    
      config = repartido;
    }
  
      let selectedQuestions: { key: string, text: string }[] = [];
  
    for (const comp of Object.keys(config)) {
      const cantidad = config[comp];
      const ref = doc(this.firestore, `competencias/${comp}`);
      const snapshot = await getDoc(ref);
      const preguntas = snapshot.data()?.['preguntas'] || [];
  
      const shuffled = preguntas.sort(() => 0.5 - Math.random());
      const seleccionadas = shuffled.slice(0, cantidad);
  
      seleccionadas.forEach((q: string, i: number) => {
        selectedQuestions.push({
          key: `${etiquetas[comp]} - Pregunta ${i + 1}`,
          text: q
        });
      });
    }
  
    return selectedQuestions.sort(() => 0.5 - Math.random());
  }  
}
