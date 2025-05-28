import { Component, OnInit, ViewChild, ElementRef, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ChatStorageService, Conversation } from '../services/chat-storage.service';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import { QuestionService } from '../services/question.service';

@Component({
  selector: 'app-chatbot',
  standalone: true,
  imports: [FormsModule, CommonModule],
  templateUrl: './chatbot.component.html',
  styleUrls: ['./chatbot.component.css'],
})
export class ChatbotComponent implements OnInit {
  private http = inject(HttpClient);
  private sanitizer = inject(DomSanitizer);

  @ViewChild('chatContainer') chatContainer!: ElementRef;

  userName = '';
  userMessage = '';
  messages: { sender: 'user' | 'bot'; text: string; html?: SafeHtml }[] = [];
  conversations: Conversation[] = [];
  currentConversation: Conversation | null = null;

  hasName = false;
  showMenu = false;
  isLoading = false;
  processCompleted = false;
  awaitingFollowUp = false;
  chatTerminado = false; // 🔒 Bloquea el chat una vez terminado
  questionIndex = 0;
  userAnswers: Record<string, string> = {};
  questions: { key: string; text: string }[] = [];

  constructor(
    private chatStorage: ChatStorageService,
    private questionService: QuestionService
  ) {}

  async ngOnInit(): Promise<void> {
    this.conversations = this.chatStorage.getConversations();
    await this.typeBotMessage('¡Hola! Soy tu orientador vocacional de la Universidad Técnica de Machala (UTMACH). ¿Cuál es tu nombre?');

    try {
      this.questions = await this.questionService.getRandomQuestionsByCompetence(10);
    } catch (err) {
      console.error('Error al cargar preguntas:', err);
      await this.typeBotMessage('No se pudieron cargar las preguntas de la base de datos.');
    }

    window.onbeforeunload = () => {
      if (this.messages.length > 0 && this.hasName) {
        this.chatStorage.saveConversation(this.userName, this.messages);
      }
    };
  }

  // NUEVA FUNCIÓN para detectar respuestas no entendidas o sin sentido
  private isAnswerValid(answer: string): boolean {
    const lowAnswer = answer.toLowerCase().trim();

    // Respuestas "sin sentido" o comunes para indicar no entender
    const invalidPatterns = [
      /^([a-z]{2,}){3,}$/, // como "dsadas", "asdqwe" (secuencia de letras sin sentido)
      'no entiendo',
      'no comprendo',
      'no se',
      'no sé',
      'no lo entiendo',
      'no entendí',
      'no comprendo',
      'no comprendo la pregunta',
      'no te entiendo',
      '???',
      '...'
    ];

    for (const pattern of invalidPatterns) {
      if (typeof pattern === 'string') {
        if (lowAnswer.includes(pattern)) return false;
      } else {
        // es regex
        if (pattern.test(lowAnswer)) return false;
      }
    }
    // Si la respuesta tiene muy pocos caracteres o solo números, puede ser inválida
    if (lowAnswer.length <= 2) return false;
    if (/^\d+$/.test(lowAnswer)) return false;

    return true;
  }

  async sendMessage(): Promise<void> {
    if (!this.userMessage.trim()) return;

    const userText = this.userMessage.trim();
    this.messages.push({ sender: 'user', text: userText });
    this.userMessage = '';
    this.scrollToBottom();

    if (!this.hasName) {
      this.userName = this.extractNameFromMessage(userText) || 'amigo';
      this.hasName = true;

      const intro = `
¡Qué gusto conocerte, ${this.userName.split(' ')[0]}! 😊 Estoy aquí para ayudarte a descubrir qué carrera te va mejor.
Antes, déjame hacerte algunas preguntas para conocerte mejor. ¿Listo?

${this.questions[this.questionIndex].text}
      `.trim();

      await this.typeBotMessage(intro);
      return;
    }

    if (this.questionIndex < this.questions.length) {
      const currentQuestion = this.questions[this.questionIndex];

      // Validar respuesta:
      const isValid = this.isAnswerValid(userText);

      if (!isValid) {
        // Si la respuesta no se entiende, la IA debe reformular la misma pregunta
        const reformulatePrompt = `
El estudiante respondió algo que no se entiende o no tiene sentido:

"${userText}"

Por favor, reformula la siguiente pregunta para que sea más clara y explíquela mejor, sin avanzar a la siguiente pregunta:

"${currentQuestion.text}"
        `.trim();

        const reformulatedQuestion = await this.getReformulatedQuestion(reformulatePrompt);
        await this.typeBotMessage(reformulatedQuestion);
        // No avanzar el índice, repetir la misma pregunta
        return;
      }

      // Si la respuesta es válida, la guardamos y avanzamos índice
      this.userAnswers[currentQuestion.key] = userText;
      this.questionIndex++;

      // Control estricto: no hacer de más  preguntas válidas
if (this.questionIndex >= this.questions.length) {
  await this.typeBotMessage('Gracias por compartir todo eso conmigo. Déjame analizar tus respuestas...');
  await this.finishAndSendToAPI();
  this.chatTerminado = true; // 🔒 Bloquea el chat
  return;
}

      // Siguiente pregunta
      const nextQuestion = this.questionIndex < this.questions.length
        ? this.questions[this.questionIndex].text
        : '';

      const naturalResponse = await this.generateNaturalResponse(
        currentQuestion.text,
        userText,
        nextQuestion
      );

      await this.typeBotMessage(naturalResponse);

    } else if (this.awaitingFollowUp) {
      const followUpPrompt = `
El estudiante ha respondido después de recibir su recomendación:

"${userText}"

Por favor, responde de forma cálida, breve y útil como orientador vocacional. Si es una pregunta sobre una carrera, da más detalles. Si es una expresión como "gracias", responde de forma amable.
      `.trim();

      const res = await this.http.post<{ response: string }>(
        'https://chatbot-orientacion.onrender.com/api/chat',
        { message: followUpPrompt }
      ).toPromise();

      const reply = res?.response || 'Gracias por tu mensaje. ¿Quieres saber más sobre alguna carrera?';
      await this.typeBotMessage(reply);
    } else {
      await this.typeBotMessage('No tengo más preguntas para ti. Si deseas reiniciar la conversación, recarga la página.');
    }
  }

  private async getReformulatedQuestion(prompt: string): Promise<string> {
    try {
      const res = await this.http.post<{ response: string }>(
        'https://chatbot-orientacion.onrender.com/api/chat',
        { message: prompt }
      ).toPromise();

      return res?.response || 'Perdona, no entendí bien tu respuesta. ' + this.questions[this.questionIndex].text;
    } catch (err) {
      console.error('Error reformulando pregunta:', err);
      return 'Perdona, no entendí bien tu respuesta. ' + this.questions[this.questionIndex].text;
    }
  }

async typeBotMessage(text: string): Promise<void> {
  const speed = 5;
  let displayed = '';
  const message: { sender: 'bot'; text: string; html?: SafeHtml } = { sender: 'bot', text: '' };
  this.messages.push(message);

  for (let i = 0; i < text.length; i++) {
    displayed += text[i];
    message.text = displayed;
    if (i % 5 === 0) this.scrollToBottom(); // Menos llamadas
    await new Promise(r => setTimeout(r, speed));
  }
  this.scrollToBottom(); // Asegura el final

  }

  async generateNaturalResponse(currentQuestion: string, studentAnswer: string, nextQuestion: string): Promise<string> {
    const prompt = `
Eres un orientador vocacional cálido, empático y cercano de la Universidad Técnica de Machala (UTMACH). Tu tarea es continuar la conversación con el estudiante como si hablaras naturalmente con él.

1. Comenta de forma empática y natural lo que respondió el estudiante, mostrando comprensión o validación.
2. Luego, enlaza de manera suave con la siguiente pregunta, haciéndola parte del flujo de la charla.
3. Usa un solo mensaje fluido y natural, no enumeres partes. No uses comillas.
4. No agregues detalles que el estudiante no mencionó. Solo comenta lo que dijo, valorando su respuesta y empatizando.

Ejemplo:
Pregunta: "¿Qué disfrutas hacer en tu tiempo libre?"
Respuesta del estudiante: "Me gusta crear contenido y trabajar en equipo."
Siguiente pregunta: "¿Qué tal te llevas con los números y las matemáticas?"

Respuesta esperada:
¡Qué interesante que disfrutes crear contenido y que te guste trabajar con otros! Eso habla muy bien de tu creatividad y habilidades sociales. Ahora cuéntame, ¿qué tal te llevas con los números y las matemáticas?

Ahora genera una respuesta con base en:
Pregunta: "${currentQuestion}"
Respuesta del estudiante: "${studentAnswer}"
Siguiente pregunta: "${nextQuestion}"
    `.trim();

    try {
      const res = await this.http.post<{ response: string }>(
        'https://chatbot-orientacion.onrender.com/api/chat',
        { message: prompt }
      ).toPromise();

      return res?.response || 'Gracias por tu respuesta. Vamos con otra pregunta.';
    } catch (err) {
      console.error('Error generando respuesta natural:', err);
      return 'Gracias por tu respuesta. Vamos con otra pregunta.';
    }
  }

  async finishAndSendToAPI(): Promise<void> {
    const resumen = Object.entries(this.userAnswers)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');

    const promptFinal = `
Este es el resumen de las respuestas del estudiante. Redacta en español:

${resumen}

Con base en esto, ¿qué carreras de la Universidad Técnica de Machala (UTMACH) se ajustan mejor a su perfil?

Escribe como un orientador cálido, usando lenguaje sencillo, motivador y cercano.
    `.trim();

    this.isLoading = true;

    try {
      const res = await this.http.post<{ response: string }>(
        'https://chatbot-orientacion.onrender.com/api/chat',
        { message: promptFinal }
      ).toPromise();

      this.isLoading = false;

      if (res?.response) {
        const html = await this.parseMarkdown(res.response);
        this.messages.push({ sender: 'bot', text: res.response, html });
        this.processCompleted = true;
        this.chatStorage.saveConversation(this.userName, this.messages);
        this.scrollToBottom();
      } else {
        await this.typeBotMessage('No se pudo generar una recomendación de carreras.');
      }
    } catch (err) {
      this.isLoading = false;
      console.error('Error al enviar resumen:', err);
      await this.typeBotMessage('Ocurrió un error al analizar tus respuestas.');
    }
  }

  extractNameFromMessage(message: string): string | null {
    const match = message.match(/(?:me llamo|soy)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ]+)/i);
    return match?.[1] || message.trim().split(' ')[0] || null;
  }

  async parseMarkdown(text: string): Promise<SafeHtml> {
    const html = await marked.parse(text);
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  scrollToBottom(): void {
    setTimeout(() => {
      try {
        this.chatContainer.nativeElement.scrollTop = this.chatContainer.nativeElement.scrollHeight;
      } catch (err) {
        console.warn('Error al hacer scroll:', err);
      }
    }, 100);
  }

  resetChat(): void {
    this.messages = [];
    this.userMessage = '';
    this.userAnswers = {};
    this.questionIndex = 0;
    this.hasName = false;
    this.userName = '';
    this.currentConversation = null;
    this.processCompleted = false;

    this.questionService.getRandomQuestionsByCompetence(10).then(questions => {
      this.questions = questions;
      this.typeBotMessage('¡Hola! Soy tu orientador vocacional de la Universidad Técnica de Machala (UTMACH). ¿Cuál es tu nombre?');
    }).catch(err => {
      console.error('Error al cargar preguntas:', err);
      this.typeBotMessage('No se pudieron cargar las preguntas de la base de datos.');
    });
  }

  toggleMenu(): void {
    this.showMenu = !this.showMenu;
  }

  async loadConversation(userName: string): Promise<void> {
    const previous = this.chatStorage.getConversationByUser(userName);
    if (previous.length > 0) {
      this.userName = userName;
      this.hasName = true;

      this.messages = await Promise.all(previous.map(async msg =>
        msg.sender === 'bot' ? { ...msg, html: await this.parseMarkdown(msg.text) } : msg
      ));

      this.currentConversation = { userName, messages: this.messages };
      this.scrollToBottom();
    }
  }

  deleteConversation(userName: string): void {
    if (confirm(`¿Eliminar la conversación con "${userName}"?`)) {
      this.chatStorage.deleteConversation(userName);
      this.conversations = this.chatStorage.getConversations();
      if (this.currentConversation?.userName === userName) this.resetChat();
    }
  }
}