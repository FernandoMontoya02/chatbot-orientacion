import { Injectable } from '@angular/core';

export interface Message {
  sender: 'user' | 'bot';
  text: string;
}

export interface Conversation {
  userName: string;
  messages: Message[];
}

@Injectable({
  providedIn: 'root'
})
export class ChatStorageService {

  constructor() { }

  // Guardar conversación por usuario
  saveConversation(userName: string, messages: { sender: 'user' | 'bot'; text: string; html?: any }[]) {
    const conversations = this.getConversations().filter(conv => conv.userName !== userName);
  
    // Limpiar `html` antes de guardar
    const cleanedMessages = messages.map(msg => ({
      sender: msg.sender,
      text: msg.text
    }));
  
    conversations.push({ userName, messages: cleanedMessages });
    localStorage.setItem("chatConversations", JSON.stringify(conversations));
  }
  

  // Obtener todas las conversaciones
  getConversations(): Conversation[] {
    return JSON.parse(localStorage.getItem('chatConversations') || '[]');
  }

  // Obtener la conversación de un usuario específico
  getConversationByUser(userName: string): Message[] {
    const allConversations = this.getConversations();
    const userConversation = allConversations.find((conv: Conversation) => this.isSimilarName(conv.userName, userName));
    return userConversation ? userConversation.messages : [];
  }

  // Función para comparar nombres de manera flexible (usando similitud)
  isSimilarName(name1: string, name2: string): boolean {
    return name1.toLowerCase().trim() === name2.toLowerCase().trim();
  }

  // Eliminar conversación de un usuario específico
deleteConversation(userName: string): void {
  const updatedConversations = this.getConversations().filter(
    (conv: Conversation) => !this.isSimilarName(conv.userName, userName)
  );
  localStorage.setItem('chatConversations', JSON.stringify(updatedConversations));
}

}