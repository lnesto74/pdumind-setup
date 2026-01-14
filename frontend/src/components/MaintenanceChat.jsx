import React, { useState, useRef, useEffect } from 'react';
import api from '../api';

const initialSuggestions = [
  'How much energy did my PDUs consume last week?',
  'Are there any overloaded circuits?',
  "What's the trend in power usage by rack?",
  'Show me any anomalies detected today.',
  'Which outlet has cycled the most in the last 24 hours?'
];

const MaintenanceChat = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [suggestions] = useState(initialSuggestions);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setLoading(true);

    try {
      const response = await api.post('/api/maintenance/ask', { 
        question: userMessage 
      });
      
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: response.data.answer 
      }]);
    } catch (error) {
      console.error('Error:', error);
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: 'Sorry, I encountered an error. Please try again.' 
      }]);
    }

    setLoading(false);
  };

  const handleSuggestionClick = async (q) => {
    // Directly send the suggested question
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: q }]);
    setLoading(true);
    try {
      const response = await api.post('/api/maintenance/ask', { question: q });
      setMessages(prev => [...prev, { role: 'assistant', content: response.data.answer }]);
    } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' }]);
    }
    setLoading(false);
  };

  return (
    <div className="flex flex-col h-[600px] max-w-3xl mx-auto my-8 border rounded-lg shadow-lg">
      <div className="bg-blue-600 text-white px-4 py-3 rounded-t-lg">
        <h2 className="text-xl font-semibold">PDUMind Maintenance Assistant</h2>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-4 py-2 ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-800'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-800 rounded-lg px-4 py-2">
              Thinking...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center p-8 space-y-6">
          <h3 className="text-lg font-medium text-gray-700">Suggested questions</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-2xl">
            {suggestions.map((s, idx) => (
              <button
                key={idx}
                onClick={() => handleSuggestionClick(s)}
                className="text-left p-4 bg-white hover:bg-gray-50 border border-gray-200 rounded-xl shadow-sm 
                           transition-all duration-200 hover:shadow-md hover:border-blue-300 hover:scale-[1.02]
                           flex items-start space-x-3"
              >
                <span className="text-blue-600 mt-1">→</span>
                <span className="text-gray-700">{s}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="p-4 border-t">
        <div className="flex space-x-4">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about PDU maintenance, telemetry, or issues..."
            className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
};

export default MaintenanceChat;
