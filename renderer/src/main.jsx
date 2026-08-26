import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// 终末地主题为固定暗色:标记 body.dark 供图表主题读取
document.body.classList.add('dark');

createRoot(document.getElementById('root')).render(<App />);
