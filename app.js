const express = require('express');
const app = express();

// Middleware pour gérer le corps des requêtes JSON
app.use(express.json());

// Route GET de base
app.get('/', (req, res) => {
  res.send('Bienvenue sur le serveur Express!');
});

// Démarrer le serveur sur le port 3000
const port = 3000;
const ip = '0.0.0.0'; 
app.listen(port, () => {
  console.log(`Serveur démarré sur http://20.19.81.107:${port}`);
});
